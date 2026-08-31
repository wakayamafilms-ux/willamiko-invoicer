const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { GoogleGenAI, Type } = require("@google/genai");

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";
const plaidItemsFile = path.join(__dirname, "plaid-items.json");
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

function readPlaidItems() {
  if (!fs.existsSync(plaidItemsFile)) return [];

  try {
    return JSON.parse(fs.readFileSync(plaidItemsFile, "utf8"));
  } catch (err) {
    console.error("Could not read Plaid item store:", err);
    return [];
  }
}

function writePlaidItems(items) {
  fs.writeFileSync(plaidItemsFile, JSON.stringify(items, null, 2));
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

// TEST ROUTE
app.get("/", (req, res) => {
  res.send("Server is running");
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

app.post("/api/plaid/create-link-token", async (req, res) => {
  if (!requirePlaidConfig(res)) return;

  try {
    const request = {
      user: {
        client_user_id: req.body.userId || "willamiko-user",
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
    const items = readPlaidItems();
    const existing = items.filter((item) => item.item_id !== itemId);

    writePlaidItems([
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
    const items = readPlaidItems();
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
      writePlaidItems(updatedItems);
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
    const items = readPlaidItems();
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
    const items = readPlaidItems();
    const item = items.find((savedItem) => savedItem.item_id === req.params.itemId);

    if (item) {
      await plaidClient.itemRemove({ access_token: item.access_token });
    }

    writePlaidItems(items.filter((savedItem) => savedItem.item_id !== req.params.itemId));
    res.send({ success: true });
  } catch (err) {
    console.error("Plaid remove item error:", err.response?.data || err);
    res.status(500).send(err.response?.data?.error_message || "Could not remove Plaid item.");
  }
});

// GENERATE PDF
app.post("/generate-pdf", (req, res) => {
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
app.post("/host-invoice-pdf", upload.single("invoicePdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No PDF uploaded");
    }

    const filename = `invoice-${Date.now()}.pdf`;
    const filepath = path.join(invoicesDir, filename);

    fs.writeFileSync(filepath, req.file.buffer);

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

      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        return res.status(500).send("Missing EMAIL_USER or EMAIL_PASS in .env file.");
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
      
      

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      await transporter.sendMail({
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
});
