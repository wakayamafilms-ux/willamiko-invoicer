const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { GoogleGenAI, Type } = require("@google/genai");
const {
  pool,
  normalizeUsername,
  hashPassword,
  passwordMatches,
  signToken,
  initializeDatabase,
  requireAuth,
  requireAdmin,
  encryptSecret,
  decryptSecret,
} = require("./auth");

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const plaidClient =
  process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET
    ? new PlaidApi(
        new Configuration({
          basePath: PlaidEnvironments[PLAID_ENV],
          baseOptions: {
            headers: {
              "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
              "PLAID-SECRET": process.env.PLAID_SECRET,
            },
          },
        })
      )
    : null;
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const ACCOUNTING_CATEGORIES = [
  "Advertising",
  "Automobile",
  "Bank Fees",
  "Contract Labor",
  "Equipment",
  "Insurance",
  "Meals",
  "Office Supplies",
  "Professional Services",
  "Rent",
  "Repairs",
  "Software",
  "Taxes",
  "Travel",
  "Utilities",
  "Income",
  "Uncategorized",
];

async function storeReceipt(userId, file) {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return null;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  await fetch(`${baseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ id: "receipts", name: "receipts", public: false }),
  });
  const extension = path.extname(file.originalname || "") ||
    (file.mimetype === "application/pdf" ? ".pdf" : ".jpg");
  const objectPath = `${userId}/${crypto.randomUUID()}${extension.toLowerCase()}`;
  const response = await fetch(
    `${baseUrl}/storage/v1/object/receipts/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": file.mimetype, "x-upsert": "false" },
      body: file.buffer,
    }
  );
  if (!response.ok) throw new Error(`Receipt storage failed: ${await response.text()}`);
  return objectPath;
}

async function analyzeReceiptFile(file, userId) {
  if (!file) throw new Error("Choose a receipt image or PDF.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Receipt must be under 10 MB.");
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype) && file.mimetype !== "application/pdf") {
    throw new Error("Use a JPG, PNG, WEBP, HEIC, or PDF receipt.");
  }
  if (!gemini) throw new Error("Missing GEMINI_API_KEY in the server environment.");

  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_RECEIPT_MODEL || "gemini-2.5-flash",
    contents: [
      { inlineData: { mimeType: file.mimetype, data: file.buffer.toString("base64") } },
      { text: `Extract this business receipt. Use YYYY-MM-DD for date. Choose category only from: ${ACCOUNTING_CATEGORIES.join(", ")}. Use the final charged total for amount. Return empty strings when unreadable.` },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          payee: { type: Type.STRING },
          date: { type: Type.STRING },
          amount: { type: Type.NUMBER },
          subtotal: { type: Type.NUMBER },
          tax: { type: Type.NUMBER },
          category: { type: Type.STRING, enum: ACCOUNTING_CATEGORIES },
          paymentAccountHint: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ["payee", "date", "amount", "subtotal", "tax", "category", "paymentAccountHint", "notes"],
      },
    },
  });
  const extracted = JSON.parse(response.text);
  const receiptPath = await storeReceipt(userId, file);
  return {
    extracted,
    receiptPath,
    stored: Boolean(receiptPath),
    fileName: file.originalname || "iPhone receipt",
  };
}

async function readPlaidItems(userId) {
  const result = await pool.query(
    `SELECT item_id, access_token, institution, cursor, created_at
     FROM plaid_items WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );
  return result.rows.map((item) => ({
    ...item,
    access_token: decryptSecret(item.access_token),
  }));
}

async function writePlaidItems(userId, items) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM plaid_items WHERE user_id = $1", [userId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO plaid_items
          (item_id, user_id, access_token, institution, cursor, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))`,
        [
          item.item_id,
          userId,
          encryptSecret(item.access_token),
          item.institution,
          item.cursor || null,
          item.created_at || null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function requirePlaidConfig(res) {
  if (!plaidClient) {
    res
      .status(500)
      .send("Missing PLAID_CLIENT_ID or PLAID_SECRET in the server .env file.");
    return false;
  }

  return true;
}

async function createEmailTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error("Missing EMAIL_USER or EMAIL_PASS in the Render backend environment.");
  }
  const smtpAddresses = await dns.resolve4("smtp.gmail.com");
  if (!smtpAddresses.length) throw new Error("Could not resolve Gmail's IPv4 SMTP address.");
  return nodemailer.createTransport({
    host: smtpAddresses[0],
    port: 587,
    secure: false,
    requireTLS: true,
    tls: { servername: "smtp.gmail.com" },
    auth: {
      user: process.env.EMAIL_USER.trim(),
      pass: process.env.EMAIL_PASS.replace(/\s/g, ""),
    },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });
}

function hasGmailApiConfig() {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET &&
      process.env.GMAIL_OAUTH_REFRESH_TOKEN
  );
}

async function getGmailAccessToken() {
  if (!hasGmailApiConfig()) {
    throw new Error("Missing Gmail API OAuth environment variables.");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID.trim(),
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET.trim(),
      refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    throw new Error(
      result.error_description || result.error || "Google could not authorize the Gmail API."
    );
  }
  return result.access_token;
}

async function sendWithGmailApi(message) {
  const accessToken = await getGmailAccessToken();
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await composer.sendMail(message);
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: composed.message.toString("base64url") }),
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      result.error?.message || `Gmail API send failed (${response.status}).`
    );
  }
  return result;
}

async function sendEmailMessage(message) {
  if (hasGmailApiConfig()) return sendWithGmailApi(message);

  if (!process.env.RESEND_API_KEY) {
    const transporter = await createEmailTransporter();
    return transporter.sendMail(message);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || message.from,
      reply_to: message.replyTo,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      html: message.html,
      attachments: message.attachments?.map((file) => ({
        filename: file.filename,
        content: Buffer.isBuffer(file.content)
          ? file.content.toString("base64")
          : file.content,
      })),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.message || result.error || `Email API failed (${response.status}).`);
  }
  return result;
}

function normalizePlaidTransaction(transaction, accountName) {
  return {
    id: transaction.transaction_id,
    plaidTransactionId: transaction.transaction_id,
    date: transaction.date,
    description:
      transaction.merchant_name ||
      transaction.name ||
      transaction.original_description ||
      "Plaid transaction",
    account: accountName,
    amount: -Number(transaction.amount || 0),
    category:
      transaction.personal_finance_category?.primary ||
      transaction.category?.[0] ||
      "Uncategorized",
    status: transaction.pending ? "Pending" : "For review",
  };
}


// Make invoices folder if it doesn't exist
const invoicesDir = path.join(__dirname, "invoices");
if (!fs.existsSync(invoicesDir)) {
  fs.mkdirSync(invoicesDir);
}

// Serve hosted PDFs
app.use("/invoices", express.static(invoicesDir));

// Render's filesystem is temporary, so durable invoice PDFs are read from Postgres.
app.get("/invoices/:filename", async (req, res) => {
  try {
    const match = /^invoice-([0-9a-f-]{36})\.pdf$/i.exec(req.params.filename);
    if (!match) return res.status(404).send("Invoice PDF not found.");
    const result = await pool.query(
      "SELECT filename, content FROM hosted_invoice_pdfs WHERE token = $1",
      [match[1]]
    );
    if (!result.rows[0]) return res.status(404).send("Invoice PDF not found.");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${result.rows[0].filename.replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(result.rows[0].content);
  } catch (err) {
    console.error("Invoice PDF download error:", err);
    res.status(500).send("Could not open invoice PDF.");
  }
});

// TEST ROUTE
app.get("/", (req, res) => {
  res.send("Server is running");
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const result = await pool.query(
      "SELECT id, username, password_hash, role FROM users WHERE username = $1 AND active = TRUE",
      [username]
    );
    const user = result.rows[0];
    if (!user || !passwordMatches(String(req.body.password || ""), user.password_hash)) {
      return res.status(401).send("Incorrect username or password.");
    }
    res.send({
      token: signToken(user),
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).send("Could not sign in.");
  }
});

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/public/receipt-captures/")) return next();
  return requireAuth(req, res, next);
});

app.get("/api/auth/me", (req, res) => res.send({ user: req.user }));

app.post("/api/auth/change-password", async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 12) {
    return res.status(400).send("New password must be at least 12 characters.");
  }
  const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!passwordMatches(currentPassword, result.rows[0]?.password_hash)) {
    return res.status(401).send("Current password is incorrect.");
  }
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    hashPassword(newPassword),
    req.user.id,
  ]);
  res.send({ success: true });
});

app.get("/api/email/status", async (req, res) => {
  try {
    if (hasGmailApiConfig()) {
      await getGmailAccessToken();
      return res.send({
        connected: true,
        provider: "Gmail HTTPS API",
        sender: process.env.EMAIL_USER?.trim() || "Gmail",
      });
    }
    if (process.env.RESEND_API_KEY) {
      return res.send({
        connected: true,
        provider: "Resend HTTPS API",
        sender: process.env.EMAIL_FROM || process.env.EMAIL_USER || "Not configured",
      });
    }
    const transporter = await createEmailTransporter();
    await transporter.verify();
    res.send({ connected: true, sender: process.env.EMAIL_USER.trim() });
  } catch (error) {
    console.error("Email connection check failed:", error);
    res.status(503).send(
      error.code === "EAUTH"
        ? "Gmail rejected the credentials. Use a 16-character Google App Password."
        : error.message || "Could not connect to Gmail."
    );
  }
});

app.get("/api/data", async (req, res) => {
  const result = await pool.query("SELECT data FROM user_data WHERE user_id = $1", [req.user.id]);
  res.send({ data: result.rows[0]?.data || {}, isNew: !result.rows[0] });
});

app.put("/api/data", async (req, res) => {
  const data = req.body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).send("Data must be an object.");
  }
  await pool.query(
    `INSERT INTO user_data (user_id, data, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [req.user.id, data]
  );
  res.send({ success: true });
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, role, active, created_at FROM users ORDER BY created_at"
  );
  res.send({ users: result.rows });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).send("Username must be 3–40 letters, numbers, dots, dashes, or underscores.");
    }
    if (password.length < 12) return res.status(400).send("Password must be at least 12 characters.");
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'user')
       RETURNING id, username, role, active, created_at`,
      [username, hashPassword(password)]
    );
    res.status(201).send({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).send("That username already exists.");
    console.error("Create user error:", error);
    res.status(500).send("Could not create user.");
  }
});

app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
  if (String(req.user.id) === String(req.params.id) && req.body.active === false) {
    return res.status(400).send("You cannot disable your own account.");
  }
  const fields = [];
  const values = [];
  if (typeof req.body.active === "boolean") {
    values.push(req.body.active);
    fields.push(`active = $${values.length}`);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 12) {
      return res.status(400).send("Password must be at least 12 characters.");
    }
    values.push(hashPassword(String(req.body.password)));
    fields.push(`password_hash = $${values.length}`);
  }
  if (!fields.length) return res.status(400).send("No account changes supplied.");
  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE users SET ${fields.join(", ")} WHERE id = $${values.length}
     RETURNING id, username, role, active, created_at`,
    values
  );
  if (!result.rows[0]) return res.status(404).send("User not found.");
  res.send({ user: result.rows[0] });
});

app.post("/api/ai/categorize-transactions", async (req, res) => {
  try {
    const transactions = Array.isArray(req.body.transactions)
      ? req.body.transactions.slice(0, 100)
      : [];

    if (!transactions.length) {
      return res.send({ suggestions: [] });
    }

    if (!gemini) {
      return res.status(500).send("Missing GEMINI_API_KEY in the server .env file.");
    }

    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_CATEGORIZATION_MODEL || "gemini-2.5-flash",
      contents: [
        "Classify these small-business accounting transactions.",
        "Choose only from the provided categories.",
        "Use Income only for positive inflows. Prefer specific deductible expense categories over Uncategorized.",
        JSON.stringify({
          categories: ACCOUNTING_CATEGORIES,
          transactions: transactions.map((transaction) => ({
            id: String(transaction.id),
            date: transaction.date,
            description: transaction.description,
            amount: transaction.amount,
            currentCategory: transaction.category,
          })),
        }),
      ].join("\n\n"),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suggestions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  category: { type: Type.STRING, enum: ACCOUNTING_CATEGORIES },
                  confidence: { type: Type.NUMBER },
                  reason: { type: Type.STRING },
                },
                required: ["id", "category", "confidence", "reason"],
                propertyOrdering: ["id", "category", "confidence", "reason"],
              },
            },
          },
          required: ["suggestions"],
          propertyOrdering: ["suggestions"],
        },
      },
    });

    res.send(JSON.parse(response.text));
  } catch (err) {
    console.error("AI categorization error:", err);
    res.status(500).send(err.message || "Could not categorize transactions.");
  }
});

app.post("/api/receipts/analyze", upload.single("receipt"), async (req, res) => {
  try {
    res.send(await analyzeReceiptFile(req.file, req.user.id));
  } catch (error) {
    console.error("Receipt analysis error:", error);
    res.status(500).send(error.message || "Could not analyze receipt.");
  }
});

app.post("/api/receipt-captures", async (req, res) => {
  const token = crypto.randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO receipt_capture_sessions (token, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
    [token, req.user.id]
  );
  res.status(201).send({ token, expiresInSeconds: 600 });
});

app.get("/api/receipt-captures/:token", async (req, res) => {
  const result = await pool.query(
    `SELECT status, result, expires_at FROM receipt_capture_sessions
     WHERE token = $1 AND user_id = $2`,
    [req.params.token, req.user.id]
  );
  const session = result.rows[0];
  if (!session) return res.status(404).send("Capture session not found.");
  if (new Date(session.expires_at) < new Date()) return res.status(410).send("Capture session expired.");
  res.send(session);
});

app.post("/api/public/receipt-captures/:token", upload.single("receipt"), async (req, res) => {
  try {
    const sessionResult = await pool.query(
      `SELECT token, user_id FROM receipt_capture_sessions
       WHERE token = $1 AND status = 'waiting' AND expires_at > NOW()`,
      [req.params.token]
    );
    const session = sessionResult.rows[0];
    if (!session) return res.status(410).send("This capture link expired or was already used.");
    const result = await analyzeReceiptFile(req.file, session.user_id);
    await pool.query(
      `UPDATE receipt_capture_sessions SET status = 'complete', result = $1 WHERE token = $2`,
      [result, session.token]
    );
    res.send({ success: true });
  } catch (error) {
    console.error("Remote receipt capture error:", error);
    res.status(500).send(error.message || "Could not process receipt.");
  }
});

app.post("/api/plaid/create-link-token", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const request = {
      user: {
        client_user_id: `willamiko-user-${req.user.id}`,
      },
      client_name: "Willamiko Accounter",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      transactions: {
        days_requested: 730,
      },
    };

    if (process.env.PLAID_WEBHOOK_URL) {
      request.webhook = process.env.PLAID_WEBHOOK_URL;
    }

    const response = await plaidClient.linkTokenCreate(request);
    res.send({ link_token: response.data.link_token });
  } catch (err) {
    console.error("Plaid link token error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error_message || "Could not create Plaid Link token.");
  }
});

app.post("/api/plaid/exchange-public-token", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const { public_token: publicToken, institution } = req.body;

    if (!publicToken) {
      return res.status(400).send("Missing Plaid public token.");
    }

    const tokenResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });
    const accessToken = tokenResponse.data.access_token;
    const itemId = tokenResponse.data.item_id;
    const items = await readPlaidItems(req.user.id);
    const existing = items.filter((item) => item.item_id !== itemId);

    await writePlaidItems(req.user.id, [
      ...existing,
      {
        item_id: itemId,
        access_token: accessToken,
        institution: institution || "Plaid connection",
        cursor: null,
        created_at: new Date().toISOString(),
      },
    ]);

    res.send({ item_id: itemId });
  } catch (err) {
    console.error("Plaid token exchange error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error_message || "Could not exchange Plaid token.");
  }
});

app.post("/api/plaid/sync-transactions", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const requestedItemId = req.body.item_id;
    const items = await readPlaidItems(req.user.id);
    const selectedItems = requestedItemId
      ? items.filter((item) => item.item_id === requestedItemId)
      : items;
    const syncedItems = [];
    const allAccounts = [];
    const allTransactions = [];

    for (const item of selectedItems) {
      let cursor = item.cursor || undefined;
      let hasMore = true;
      const added = [];
      const modified = [];
      const removed = [];
      let accounts = [];

      while (hasMore) {
        const response = await plaidClient.transactionsSync({
          access_token: item.access_token,
          cursor,
          count: 500,
        });

        added.push(...response.data.added);
        modified.push(...response.data.modified);
        removed.push(...response.data.removed);
        accounts = response.data.accounts || accounts;
        cursor = response.data.next_cursor;
        hasMore = response.data.has_more;
      }

      const accountById = accounts.reduce((map, account) => {
        map[account.account_id] = account;
        return map;
      }, {});
      const normalizedAccounts = accounts.map((account) => ({
        id: account.account_id,
        plaidAccountId: account.account_id,
        itemId: item.item_id,
        name: account.name,
        institution: item.institution,
        type:
          account.type === "credit"
            ? "Credit Card"
            : account.subtype === "checking"
            ? "Bank"
            : account.subtype || account.type || "Bank",
        last4: account.mask || "",
        balance:
          account.balances?.current ??
          account.balances?.available ??
          0,
        lastSync: new Date().toLocaleString(),
      }));

      allAccounts.push(...normalizedAccounts);
      allTransactions.push(
        ...added.map((transaction) =>
          normalizePlaidTransaction(
            transaction,
            accountById[transaction.account_id]?.name || item.institution
          )
        ),
        ...modified.map((transaction) =>
          normalizePlaidTransaction(
            transaction,
            accountById[transaction.account_id]?.name || item.institution
          )
        )
      );
      syncedItems.push({
        ...item,
        cursor,
        removed_transaction_ids: removed.map((transaction) => transaction.transaction_id),
      });
    }

    if (syncedItems.length) {
      const updatedItems = items.map((item) => {
        const synced = syncedItems.find((syncedItem) => syncedItem.item_id === item.item_id);
        return synced || item;
      });
      await writePlaidItems(req.user.id, updatedItems);
    }

    res.send({
      accounts: allAccounts,
      transactions: allTransactions,
      removed_transaction_ids: syncedItems.flatMap(
        (item) => item.removed_transaction_ids || []
      ),
    });
  } catch (err) {
    console.error("Plaid sync error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error_message || "Could not sync Plaid transactions.");
  }
});

app.post("/api/plaid/refresh-transactions", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const requestedItemId = req.body.item_id;
    const items = await readPlaidItems(req.user.id);
    const selectedItems = requestedItemId
      ? items.filter((item) => item.item_id === requestedItemId)
      : items;

    if (!selectedItems.length) {
      return res.status(400).send("No Plaid connections found to refresh.");
    }

    for (const item of selectedItems) {
      await plaidClient.transactionsRefresh({
        access_token: item.access_token,
      });
    }

    res.send({
      success: true,
      refreshed_items: selectedItems.length,
    });
  } catch (err) {
    console.error("Plaid refresh error:", err.response?.data || err);
    res
      .status(500)
      .send(
        err.response?.data?.error_message ||
          "Could not refresh Plaid transactions. Transactions Refresh may need to be enabled for your Plaid account."
      );
  }
});

app.delete("/api/plaid/items/:itemId", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const items = await readPlaidItems(req.user.id);
    const item = items.find((savedItem) => savedItem.item_id === req.params.itemId);

    if (item) {
      await plaidClient.itemRemove({ access_token: item.access_token });
    }

    await writePlaidItems(
      req.user.id,
      items.filter((savedItem) => savedItem.item_id !== req.params.itemId)
    );
    res.send({ success: true });
  } catch (err) {
    console.error("Plaid remove item error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error_message || "Could not remove Plaid item.");
  }
});

// GENERATE PDF
app.post("/generate-pdf", requireAuth, (req, res) => {
  const { clientName, items } = req.body;

  const doc = new PDFDocument();
  const buffers = [];

  doc.on("data", buffers.push.bind(buffers));
  doc.on("end", () => {
    const pdfData = Buffer.concat(buffers);
    res.setHeader("Content-Type", "application/pdf");
    res.send(pdfData);
  });

  doc.fontSize(20).text("WILLAMIKO .LLC");
  doc.text("24256 Huber Ave");
  doc.text("Torrance, CA 90501");
  doc.moveDown();

  doc.text(`Bill To: ${clientName}`);
  doc.moveDown();

  items.forEach((item) => {
    doc.text(`${item.date} - ${item.description} | ${item.qty} x $${item.rate}`);
  });

  doc.end();
});

// HOST INVOICE PDF
app.post("/host-invoice-pdf", requireAuth, upload.single("invoicePdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No PDF uploaded");
    }

    const token = crypto.randomUUID();
    const filename = `invoice-${token}.pdf`;
    await pool.query(
      `INSERT INTO hosted_invoice_pdfs (token, user_id, filename, content)
       VALUES ($1, $2, $3, $4)`,
      [token, req.user.id, req.file.originalname || filename, req.file.buffer]
    );

    res.send({
      url: `https://willamiko-invoicer.onrender.com/invoices/${filename}`,
    });
  } catch (err) {
    console.error("Host PDF error:", err);
    res.status(500).send("Could not host PDF");
  }
});

// SEND EMAIL
app.post(
  "/send-email",
  requireAuth,
  upload.fields([
    { name: "invoicePdf", maxCount: 1 },
    { name: "attachments", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const { to, cc, from, subject, clientName, total, notes, hostedPdfUrl } = req.body;

      console.log("HOSTED PDF URL:", hostedPdfUrl);

      if (!to) {
        return res.status(400).send("Missing recipient email address.");
      }

      const files = [];

      if (req.files.invoicePdf?.[0]) {
        files.push({
          filename: req.files.invoicePdf[0].originalname,
          content: req.files.invoicePdf[0].buffer,
          contentType: "application/pdf",
        });
      }

      if (req.files.attachments) {
        req.files.attachments.forEach((file) => {
          files.push({
            filename: file.originalname,
            content: file.buffer,
            contentType: file.mimetype,
          });
        });
      }
      
      

      await sendEmailMessage({
        from: `"WILLAMIKO .LLC" <${process.env.EMAIL_USER}>`,
        replyTo: from || process.env.EMAIL_USER,
        to,
        cc: cc || undefined,
        subject: subject || "Invoice from WILLAMIKO .LLC",
        
        html: `
  <center style="width:100%;background:#f4f5f8;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f8;margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;">
      <tr>
        <td align="center" style="padding:0 0 24px 0;">

          <table width="680" cellpadding="0" cellspacing="0" border="0" align="center" style="width:680px;max-width:680px;margin:0 auto;background:#ffffff;color:#393a3d;text-align:center;">

           <tr>
            <td align="center" style="background:#ffffff;padding:28px 0 28px 0;">
              

            ${
              process.env.COMPANY_LOGO_URL
                ? `<img src="${process.env.COMPANY_LOGO_URL}" style="height:60px;display:block;margin:0 auto 16px auto;" />`
                : ""
            }
    
    <div style="font-size:18px;font-weight:bold;color:#393a3d;">
      WILLAMIKO .LLC
    </div>
  </td>
</tr>

            <tr>
              <td align="center" style="background:#e8f1f7;padding:36px 24px 38px 24px;color:#393a3d;text-align:center;">
                <h2 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;font-weight:700;color:#393a3d;">
                  Your invoice is ready!
                </h2>

                <p style="margin:0 0 30px 0;font-size:14px;color:#393a3d;">
                  Total ${total}
                </p>

                <div style="font-size:11px;letter-spacing:.3px;margin:0 0 8px 0;color:#393a3d;">
                  BALANCE DUE
                </div>

                <div style="font-size:38px;line-height:1.15;font-weight:400;color:#393a3d;">
                  ${total}
                </div>
              </td>
            </tr>

            <tr>
              <td align="center" style="background:#ffffff;padding:40px 44px 46px 44px;text-align:center;color:#393a3d;font-size:14px;line-height:1.6;">
                <p style="margin:0 0 22px 0;">
                  Dear ${clientName || "Customer"},
                </p>

                <p style="margin:0 0 26px 0;">
                  We appreciate your business. Please find your invoice attached.
                </p>

                ${
                  hostedPdfUrl
                    ? `
                      <div style="text-align:center; margin:32px 0;">
                        <a href="${hostedPdfUrl}"
                          style="
                            display:inline-block;
                            background:#0077c5;
                            color:#ffffff;
                            text-decoration:none;
                            font-weight:bold;
                            font-size:14px;
                            padding:14px 48px;
                            border-radius:28px;
                          ">
                          View Details
                        </a>
                      </div>
                    `
                    : ""
                }

                ${notes ? `<p style="margin:0 0 26px 0;white-space:pre-line;">${notes}</p>` : ""}

                <p style="margin:0 0 28px 0;">
                  Have a great day!<br/>
                  Willamiko
                </p>

                <p style="margin:0 0 10px 0;font-weight:bold;color:#393a3d;">
                  WILLAMIKO .LLC
                </p>

                <p style="margin:0 0 18px 0;color:#393a3d;">
                  24256 Huber Ave<br/>
                  Torrance, CA 90501
                </p>

                <p style="margin:0;color:#0077c5;">
                  wakayamafilms@gmail.com<br/>
                  +1 (310) 998-7795
                </p>
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>
  </center>
`,

        attachments: files,
      });

      res.send({ success: true });
    } catch (err) {
      console.error("Email send error:", err);
      res.status(500).send(err.message || "Email failed");
    }
  }
);

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  });
