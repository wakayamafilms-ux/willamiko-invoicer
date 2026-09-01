import { useEffect, useRef, useState } from "react";
import html2pdf from "html2pdf.js";
import "./App.css";
import html2canvas from "html2canvas";
import QRCode from "qrcode";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV
    ? "http://127.0.0.1:3001"
    : "https://willamiko-invoicer.onrender.com");
const PUBLIC_APP_URL =
  import.meta.env.VITE_PUBLIC_APP_URL ||
  (import.meta.env.DEV
    ? "https://willamiko-invoicer-1.onrender.com"
    : window.location.origin);

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const token = sessionStorage.getItem("willamiko_session");

  try {
    return await fetch(url, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getRequestErrorMessage(err, action) {
  if (err.name === "AbortError") {
    return `${action} timed out while waiting for ${API_BASE_URL}. Check the Render logs for the last printed stage.`;
  }

  return err.message || "Check console + server.";
}

const EXPENSE_CATEGORIES = [
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
  "Uncategorized",
];

const CATEGORY_RULES = [
  { words: ["adobe", "figma", "dropbox", "google workspace", "notion"], category: "Software" },
  { words: ["shell", "chevron", "76", "mobil", "parking"], category: "Automobile" },
  { words: ["staples", "office depot", "paper", "ink"], category: "Office Supplies" },
  { words: ["uber", "lyft", "delta", "southwest", "hotel", "airbnb"], category: "Travel" },
  { words: ["starbucks", "coffee", "restaurant", "cafe", "lunch"], category: "Meals" },
  { words: ["irs", "franchise tax", "tax"], category: "Taxes" },
  { words: ["bank fee", "service charge", "wire fee"], category: "Bank Fees" },
  { words: ["rent", "studio"], category: "Rent" },
  { words: ["electric", "water", "gas company", "internet", "spectrum"], category: "Utilities" },
  { words: ["contractor", "freelance", "assistant", "editor"], category: "Contract Labor" },
];

const SAMPLE_BANK_TRANSACTIONS = [
  { date: "2026-05-14", description: "Adobe Creative Cloud", amount: -59.99 },
  { date: "2026-05-13", description: "Shell Fuel Torrance", amount: -72.48 },
  { date: "2026-05-12", description: "Client ACH Deposit", amount: 1800 },
  { date: "2026-05-10", description: "Starbucks Meeting", amount: -18.72 },
  { date: "2026-05-08", description: "Office Depot Supplies", amount: -134.21 },
  { date: "2026-05-05", description: "Studio Rent", amount: -1200 },
];

function getStoredValue(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function getLegacyAccountData() {
  return {
    invoices: getStoredValue("invoices", []),
    customers: getStoredValue("accounting_customers", []),
    expenses: getStoredValue("accounting_expenses", []),
    bankAccounts: getStoredValue("accounting_bank_accounts", []),
    bankTransactions: getStoredValue("accounting_bank_transactions", []),
    vendorRules: getStoredValue("accounting_vendor_rules", []),
    drafts: getStoredValue("willamiko_drafts", []),
  };
}

function classifyTransaction(description) {
  const lower = description.toLowerCase();
  const match = CATEGORY_RULES.find((rule) =>
    rule.words.some((word) => lower.includes(word))
  );

  return match?.category || "Uncategorized";
}

function getVendorKey(description) {
  return String(description || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^\d+$/.test(word))
    .slice(0, 3)
    .join(" ");
}

function applyLearnedCategory(transaction, rules) {
  const description = String(transaction.description || "").toLowerCase();
  const rule = rules.find(
    (item) => item.vendorKey && description.includes(item.vendorKey)
  );

  if (!rule) return transaction;

  return {
    ...transaction,
    category: rule.category,
    learnedRuleId: rule.id,
  };
}

function parseMoneyValue(value) {
  return Number(String(value || "0").replace(/[^0-9.-]/g, "")) || 0;
}

function getDocumentLabel(type, format = "short") {
  const labels = {
    invoice: {
      short: "Invoice",
      upper: "INVOICE",
      lower: "invoice",
      details: "Invoice details",
      number: "Invoice no.:",
      date: "Invoice date:",
      totalLabel: "BALANCE DUE",
    },
    quote: {
      short: "Quote",
      upper: "QUOTE",
      lower: "quote",
      details: "Quote details",
      number: "Quote no.:",
      date: "Quote date:",
      totalLabel: "QUOTE TOTAL",
    },
    expense: {
      short: "Expense",
      upper: "EXPENSE",
      lower: "expense",
      details: "Expense details",
      number: "Expense no.:",
      date: "Expense date:",
      totalLabel: "EXPENSE TOTAL",
    },
  };

  return labels[type]?.[format] || labels.invoice[format];
}

function getDocumentStatuses(type) {
  return type === "quote" ? ["draft", "sent"] : ["draft", "sent", "complete"];
}

function normalizeDocumentStatus(type, status) {
  return getDocumentStatuses(type).includes(status) ? status : "draft";
}

function parseCsvRows(csvText) {
  const rows = [];
  let current = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    const next = csvText[index + 1];

    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(current.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      current = "";
    } else {
      current += char;
    }
  }

  row.push(current.trim());
  if (row.some(Boolean)) rows.push(row);

  return rows;
}

function normalizeImportedTransactions(csvText, accountName) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.toLowerCase());
  const findIndex = (names) =>
    headers.findIndex((header) => names.some((name) => header.includes(name)));
  const dateIndex = findIndex(["date", "datetime"]);
  const descriptionIndex = findIndex(["description", "note", "memo", "name", "merchant"]);
  const amountIndex = findIndex(["amount", "total"]);
  const typeIndex = findIndex(["type", "status"]);

  return rows.slice(1).map((row, index) => {
    const description = row[descriptionIndex] || row[1] || "Imported transaction";
    let amount = parseMoneyValue(row[amountIndex] || row[2]);
    const type = String(row[typeIndex] || "").toLowerCase();

    if (amount > 0 && ["payment", "purchase", "debit", "paid"].some((word) => type.includes(word))) {
      amount *= -1;
    }

    return {
      id: Date.now() + index,
      date: row[dateIndex] || new Date().toISOString().slice(0, 10),
      description,
      account: accountName,
      amount,
      category: amount < 0 ? classifyTransaction(description) : "Income",
      status: "For review",
    };
  });
}

const EMPTY_CUSTOMER_FORM = {
  name: "",
  email: "",
  phone: "",
  address1: "",
  address2: "",
  company: "",
  notes: "",
};

function loadPlaidScript() {
  return new Promise((resolve, reject) => {
    if (window.Plaid) {
      resolve();
      return;
    }

    const existingScript = document.querySelector("script[data-plaid-link]");
    if (existingScript) {
      existingScript.addEventListener("load", resolve);
      existingScript.addEventListener("error", reject);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.async = true;
    script.dataset.plaidLink = "true";
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

function App() {
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [documentType, setDocumentType] = useState("invoice");
  const [invoiceNo, setInvoiceNo] = useState("1018");
  const [terms, setTerms] = useState("Due on receipt");
  const [invoiceDate, setInvoiceDate] = useState("2026-01-27");
  const [dueDate, setDueDate] = useState("2026-01-27");
  const [invoiceStatus, setInvoiceStatus] = useState("draft");
  const [status, setStatus] = useState("");
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [showSentConfirmation, setShowSentConfirmation] = useState(false);
  const DEFAULT_LOGO =
        "https://images.squarespace-cdn.com/content/5764c682893fc02726348910/3a1bb193-0ffa-47e5-b169-5cc2f138caf8/j.waka_logo_large.jpg";

  const [logo, setLogo] = useState(DEFAULT_LOGO);
  const [emailLogo, setEmailLogo] = useState(null);
  const [logoSize, setLogoSize] = useState(80);
  const [notes, setNotes] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailFrom, setEmailFrom] = useState("wakayamafilms@gmail.com");
  const [emailSubject, setEmailSubject] = useState("");
  const [extraAttachments, setExtraAttachments] = useState([]);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [showEmailPreview, setShowEmailPreview] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState(null);
  const [hostedPdfUrl, setHostedPdfUrl] = useState(null);
  const [pdfThumbnail, setPdfThumbnail] = useState(null);
  
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  
  const [items, setItems] = useState([
    { date: "2026-01-12", product: "DP PREP", description: "", qty: 1, rate: 400 },
  ]);
  
  const [screen, setScreen] = useState("login");
  const [currentUser, setCurrentUser] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "" });
  const [passwordNotice, setPasswordNotice] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [users, setUsers] = useState([]);
  const [newUserForm, setNewUserForm] = useState({ username: "", password: "" });
  const [accountNotice, setAccountNotice] = useState("");
  const [dashboardView, setDashboardView] = useState("invoices");
  const [invoiceTab, setInvoiceTab] = useState("invoices");
  const [expenseForm, setExpenseForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    payee: "",
    category: "Uncategorized",
    amount: "",
    paymentAccount: "Business Checking",
    notes: "",
  });
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [lastExpenseAction, setLastExpenseAction] = useState(null);
  const [receiptAttachment, setReceiptAttachment] = useState(null);
  const [receiptNotice, setReceiptNotice] = useState("");
  const [isAnalyzingReceipt, setIsAnalyzingReceipt] = useState(false);
  const [remoteCapture, setRemoteCapture] = useState(null);
  const [captureToken] = useState(() =>
    new URLSearchParams(window.location.search).get("receiptCapture")
  );
  const [mobileCaptureStatus, setMobileCaptureStatus] = useState("");
  const [bankNotice, setBankNotice] = useState("");
  const [showConnectionsModal, setShowConnectionsModal] = useState(false);
  const [isPlaidConnecting, setIsPlaidConnecting] = useState(false);
  const [isCategorizingTransactions, setIsCategorizingTransactions] = useState(false);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState([]);
  const [transactionView, setTransactionView] = useState("review");
  const [editingConnectionId, setEditingConnectionId] = useState(null);
  const [connectionForm, setConnectionForm] = useState({
    type: "Bank",
    institution: "",
    name: "",
    last4: "",
    balance: "",
  });
  const [customerForm, setCustomerForm] = useState(EMPTY_CUSTOMER_FORM);
  const [editingCustomerId, setEditingCustomerId] = useState(null);
  const [showCustomerEditor, setShowCustomerEditor] = useState(false);

  const [invoices, setInvoices] = useState([]);
  const [invoiceSort, setInvoiceSort] = useState({ key: "date", direction: "desc" });
  const [customers, setCustomers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [bankTransactions, setBankTransactions] = useState([]);
  const [vendorRules, setVendorRules] = useState([]);
  const [drafts, setDrafts] = useState([]);

const [activeInvoice, setActiveInvoice] = useState(null);
  

  const invoiceRef = useRef(null);
  const newMenuRef = useRef(null);
  const toolbarMoreRef = useRef(null);
  const lastSavedInvoiceSnapshotRef = useRef(null);
  const receiptInputRef = useRef(null);

  function applyAccountData(data = {}) {
    setInvoices(Array.isArray(data.invoices) ? data.invoices : []);
    setCustomers(Array.isArray(data.customers) ? data.customers : []);
    setExpenses(Array.isArray(data.expenses) ? data.expenses : []);
    setBankAccounts(Array.isArray(data.bankAccounts) ? data.bankAccounts : []);
    setBankTransactions(Array.isArray(data.bankTransactions) ? data.bankTransactions : []);
    setVendorRules(Array.isArray(data.vendorRules) ? data.vendorRules : []);
    setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
  }

  async function loadAccountData() {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/data`);
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    let data = result.data || {};
    const legacy = getLegacyAccountData();
    const hasLegacyData = Object.values(legacy).some((rows) => rows.length);
    const serverHasData = Object.values(data).some(
      (value) => Array.isArray(value) && value.length
    );
    if (hasLegacyData && (result.isNew || !serverHasData)) {
      data = legacy;
      const migration = await fetchWithTimeout(`${API_BASE_URL}/api/data`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (!migration.ok) throw new Error(await migration.text());
      [
        "invoices",
        "accounting_customers",
        "accounting_expenses",
        "accounting_bank_accounts",
        "accounting_bank_transactions",
        "accounting_vendor_rules",
        "willamiko_drafts",
      ].forEach((key) => localStorage.removeItem(key));
    }
    applyAccountData(data);
    setDataReady(true);
  }

  async function signIn(event) {
    event.preventDefault();
    setLoginError("");
    setIsSigningIn(true);
    try {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      sessionStorage.setItem("willamiko_session", result.token);
      setCurrentUser(result.user);
      await loadAccountData();
      setScreen("dashboard");
    } catch (error) {
      sessionStorage.removeItem("willamiko_session");
      setLoginError(error.message || "Could not sign in.");
    } finally {
      setIsSigningIn(false);
    }
  }

  function signOut() {
    sessionStorage.removeItem("willamiko_session");
    setCurrentUser(null);
    setDataReady(false);
    applyAccountData({});
    setLoginForm({ username: "", password: "" });
    setScreen("login");
  }

  // Session restoration intentionally runs once; loadAccountData reads the active token.
  useEffect(() => {
    const token = sessionStorage.getItem("willamiko_session");
    if (!token) return;
    (async () => {
      try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/me`);
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        setCurrentUser(result.user);
        await loadAccountData();
        setScreen("dashboard");
      } catch {
        sessionStorage.removeItem("willamiko_session");
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dataReady || !currentUser) return undefined;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/api/data`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            data: { invoices, customers, expenses, bankAccounts, bankTransactions, vendorRules, drafts },
          }),
        });
        if (!response.ok) throw new Error(await response.text());
      } catch (error) {
        console.error("Account data save failed:", error);
      }
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [
    dataReady,
    currentUser,
    invoices,
    customers,
    expenses,
    bankAccounts,
    bankTransactions,
    vendorRules,
    drafts,
  ]);

  useEffect(() => {
    if (dashboardView !== "accounts" || currentUser?.role !== "admin") return;
    (async () => {
      try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/api/admin/users`);
        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        setUsers(result.users || []);
      } catch (error) {
        setAccountNotice(error.message || "Could not load accounts.");
      }
    })();
  }, [dashboardView, currentUser]);

  useEffect(() => {
    if (!remoteCapture?.token || !currentUser) return undefined;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetchWithTimeout(
          `${API_BASE_URL}/api/receipt-captures/${encodeURIComponent(remoteCapture.token)}`
        );
        if (!response.ok) return;
        const session = await response.json();
        if (session.status !== "complete" || !session.result) return;
        const result = session.result;
        const extracted = result.extracted || {};
        setExpenseForm((current) => ({
          ...current,
          date: /^\d{4}-\d{2}-\d{2}$/.test(extracted.date || "") ? extracted.date : current.date,
          payee: extracted.payee || current.payee,
          amount: extracted.amount || current.amount,
          category: EXPENSE_CATEGORIES.includes(extracted.category) ? extracted.category : current.category,
          notes: [extracted.notes, extracted.tax ? `Tax: ${formatMoney(extracted.tax)}` : ""]
            .filter(Boolean)
            .join(" · "),
        }));
        setReceiptAttachment({
          name: result.fileName || "iPhone receipt",
          path: result.receiptPath || null,
          stored: result.stored,
          previewUrl: null,
        });
        setReceiptNotice("iPhone receipt received. Review the details before saving.");
        setRemoteCapture(null);
      } catch (error) {
        console.error("Receipt capture polling failed:", error);
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [remoteCapture, currentUser]);

  async function createUser(event) {
    event.preventDefault();
    setAccountNotice("");
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUserForm),
    });
    if (!response.ok) {
      setAccountNotice(await response.text());
      return;
    }
    const result = await response.json();
    setUsers((current) => [...current, result.user]);
    setNewUserForm({ username: "", password: "" });
    setAccountNotice(`Account ${result.user.username} created.`);
  }

  async function setUserActive(user, active) {
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!response.ok) {
      setAccountNotice(await response.text());
      return;
    }
    const result = await response.json();
    setUsers((current) => current.map((item) => (item.id === result.user.id ? result.user : item)));
    setAccountNotice(`${result.user.username} ${active ? "enabled" : "disabled"}.`);
  }

  async function resetUserPassword(user) {
    const password = window.prompt(`Enter a new password for ${user.username} (12+ characters):`);
    if (!password) return;
    const response = await fetchWithTimeout(`${API_BASE_URL}/api/admin/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setAccountNotice(response.ok ? `${user.username}'s password was reset.` : await response.text());
  }

  async function changeMyPassword(event) {
    event.preventDefault();
    setPasswordNotice("");
    setIsChangingPassword(true);
    try {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(passwordForm),
      });
      if (!response.ok) throw new Error(await response.text());
      setPasswordNotice("Password changed. Chrome can now update your saved password.");
      window.setTimeout(() => {
        setShowPasswordModal(false);
        setPasswordForm({ currentPassword: "", newPassword: "" });
        setPasswordNotice("");
      }, 1800);
    } catch (error) {
      setPasswordNotice(error.message || "Could not change password.");
    } finally {
      setIsChangingPassword(false);
    }
  }

  useEffect(() => {
    function closeNewMenu(event) {
      if (!newMenuRef.current?.contains(event.target)) {
        newMenuRef.current?.removeAttribute("open");
      }
      if (!toolbarMoreRef.current?.contains(event.target)) {
        toolbarMoreRef.current?.removeAttribute("open");
      }
    }

    document.addEventListener("pointerdown", closeNewMenu);
    return () => document.removeEventListener("pointerdown", closeNewMenu);
  }, []);
  

  const total = items.reduce(
    (sum, item) => sum + Number(item.qty || 0) * Number(item.rate || 0),
    0
  );

  const expenseTotal = expenses.reduce(
    (sum, expense) => sum + Number(expense.amount || 0),
    0
  );
  const revenueTotal = invoices.reduce(
    (sum, invoice) =>
      invoice.documentType === "invoice"
        ? sum + parseMoneyValue(invoice.total)
        : sum,
    0
  );
  const savedCustomerRows = customers.map((customer) => {
    const customerName = String(customer.name || "");
    const customerInvoices = invoices.filter(
      (invoice) =>
        invoice.documentType === "invoice" &&
        (invoice.customerId === customer.id ||
          invoice.clientName?.toLowerCase() === customerName.toLowerCase())
    );
    const openBalance = customerInvoices.reduce(
      (sum, invoice) => sum + parseMoneyValue(invoice.total),
      0
    );

    return {
      ...customer,
      name: customerName || "Untitled",
      invoiceCount: customerInvoices.length,
      openBalance,
      lastInvoiceDate: customerInvoices[0]?.date || "",
      source: "saved",
    };
  });
  const invoiceCustomerRows = invoices
    .filter(
      (invoice) =>
        invoice.documentType === "invoice" &&
        invoice.clientName &&
        !savedCustomerRows.some(
          (customer) =>
            customer.name.toLowerCase() === invoice.clientName.toLowerCase()
        )
    )
    .reduce((rows, invoice) => {
      const existing = rows.find(
        (row) => row.name.toLowerCase() === invoice.clientName.toLowerCase()
      );

      if (existing) {
        existing.invoiceCount += 1;
        existing.openBalance += parseMoneyValue(invoice.total);
        if (!existing.lastInvoiceDate || invoice.date > existing.lastInvoiceDate) {
          existing.lastInvoiceDate = invoice.date;
        }
        return rows;
      }

      rows.push({
        id: `invoice-${invoice.id}`,
        name: invoice.clientName,
        email: invoice.data?.clientEmail || "",
        phone: "",
        address1: invoice.data?.address1 || "",
        address2: invoice.data?.address2 || "",
        company: "",
        notes: "",
        invoiceCount: 1,
        openBalance: parseMoneyValue(invoice.total),
        lastInvoiceDate: invoice.date,
        source: "invoice",
      });

      return rows;
    }, []);
  const customerRows = [...savedCustomerRows, ...invoiceCustomerRows].sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const sortedInvoices = [...invoices].sort((a, b) => {
    const getSortValue = (invoice) => {
      if (invoiceSort.key === "type") return getDocumentLabel(invoice.documentType, "short");
      if (invoiceSort.key === "number") return invoice.invoiceNo || "";
      if (invoiceSort.key === "customer") return invoice.clientName || "";
      if (invoiceSort.key === "date") return invoice.date || "";
      if (invoiceSort.key === "total") return parseMoneyValue(invoice.total);
      if (invoiceSort.key === "status") {
        return normalizeDocumentStatus(invoice.documentType, invoice.status);
      }
      return "";
    };
    const aValue = getSortValue(a);
    const bValue = getSortValue(b);
    const comparison =
      typeof aValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), undefined, {
            numeric: true,
            sensitivity: "base",
          });

    return invoiceSort.direction === "asc" ? comparison : -comparison;
  });

  function sortInvoicesBy(key) {
    setInvoiceSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  function changeSavedDocumentType(invoice, nextType) {
    const nextStatus = normalizeDocumentStatus(nextType, invoice.status);
    const updatedInvoice = {
      ...invoice,
      documentType: nextType,
      status: nextStatus,
      title: `${getDocumentLabel(nextType, "short")} ${invoice.invoiceNo || "No Number"}`,
      data: {
        ...invoice.data,
        documentType: nextType,
      },
    };
    const updatedInvoices = invoices.map((item) =>
      item.id === invoice.id ? updatedInvoice : item
    );

    setInvoices(updatedInvoices);
    setActiveInvoice(updatedInvoice);
  }
  const uncategorizedCount = bankTransactions.filter(
    (transaction) => transaction.category === "Uncategorized"
  ).length;
  const reviewCount = bankTransactions.filter(
    (transaction) => transaction.status === "For review"
  ).length;
  const connectedBalance = bankAccounts.reduce(
    (sum, account) => sum + Number(account.balance || 0),
    0
  );
  const filteredTransactions = bankTransactions.filter((transaction) => {
    if (transactionView === "review") return transaction.status !== "Matched";
    if (transactionView === "approved") return transaction.status === "Matched";
    return true;
  });
  const selectableTransactions = filteredTransactions.filter(
    (transaction) => transaction.status !== "Matched"
  );
  const allVisibleTransactionsSelected =
    selectableTransactions.length > 0 &&
    selectableTransactions.every((transaction) =>
      selectedTransactionIds.includes(transaction.id)
    );

  function saveExpenses(updated) {
    setExpenses(updated);
  }

  function saveCustomers(updated) {
    setCustomers(updated);
  }

  function updateCustomerForm(field, value) {
    setCustomerForm((current) => ({ ...current, [field]: value }));
  }

  function resetCustomerForm() {
    setCustomerForm(EMPTY_CUSTOMER_FORM);
    setEditingCustomerId(null);
  }

  function saveCustomer() {
    const trimmedName = customerForm.name.trim();

    if (!trimmedName) {
      alert("Customer name is required.");
      return;
    }

    const customer = {
      ...customerForm,
      id: editingCustomerId || Date.now(),
      name: trimmedName,
      email: customerForm.email.trim(),
      phone: customerForm.phone.trim(),
      company: customerForm.company.trim(),
      updatedAt: new Date().toISOString(),
    };
    const updated = [
      customer,
      ...customers.filter((item) => item.id !== customer.id),
    ].sort((a, b) => a.name.localeCompare(b.name));

    saveCustomers(updated);
    resetCustomerForm();
    setShowCustomerEditor(false);
  }

  function editCustomer(customer) {
    setCustomerForm({
      name: customer.name || "",
      email: customer.email || "",
      phone: customer.phone || "",
      address1: customer.address1 || "",
      address2: customer.address2 || "",
      company: customer.company || "",
      notes: customer.notes || "",
    });
    setEditingCustomerId(customer.source === "saved" ? customer.id : null);
    setShowCustomerEditor(true);
  }

  function selectInvoiceCustomer(customer) {
    if (!customer) return;
    setClientName(customer.name || "");
    setClientEmail(customer.email || "");
    setAddress1(customer.address1 || "");
    setAddress2(customer.address2 || "");
  }

  function deleteCustomer(id) {
    saveCustomers(customers.filter((customer) => customer.id !== id));
    if (editingCustomerId === id) resetCustomerForm();
  }

  function startInvoiceForCustomer(customer) {
    resetInvoice();
    setActiveInvoice(null);
    setDocumentType("invoice");
    setClientName(customer.name || "");
    setClientEmail(customer.email || "");
    setAddress1(customer.address1 || "");
    setAddress2(customer.address2 || "");
    setScreen("invoice");
  }

  function saveBankAccounts(updated) {
    setBankAccounts(updated);
  }

  function saveBankTransactions(updated) {
    setBankTransactions(updated);
  }

  function saveVendorRules(updated) {
    setVendorRules(updated);
  }

  function mergeBankAccounts(incomingAccounts) {
    const normalizedAccounts = incomingAccounts.map((account) => ({
      ...account,
      id: account.id || account.plaidAccountId || Date.now(),
    }));
    const merged = [
      ...normalizedAccounts,
      ...bankAccounts.filter(
        (account) =>
          !normalizedAccounts.some((incoming) => incoming.id === account.id)
      ),
    ];
    saveBankAccounts(merged);
  }

  function mergeBankTransactions(incomingTransactions, removedIds = []) {
    const categorizedIncoming = incomingTransactions.map((transaction) =>
      applyLearnedCategory(transaction, vendorRules)
    );
    const incomingIds = categorizedIncoming.map((transaction) => transaction.id);
    const merged = [
      ...categorizedIncoming,
      ...bankTransactions.filter(
        (transaction) =>
          !incomingIds.includes(transaction.id) &&
          !removedIds.includes(transaction.plaidTransactionId || transaction.id)
      ),
    ];
    saveBankTransactions(merged);
  }

  function updateExpenseForm(field, value) {
    setExpenseForm((current) => ({ ...current, [field]: value }));
  }

  async function analyzeReceipt(file) {
    if (!file) return;
    setIsAnalyzingReceipt(true);
    setReceiptNotice("Reading receipt…");
    try {
      const formData = new FormData();
      formData.append("receipt", file, file.name || `receipt-${Date.now()}.jpg`);
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/receipts/analyze`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      const extracted = result.extracted || {};
      setExpenseForm((current) => ({
        ...current,
        date: /^\d{4}-\d{2}-\d{2}$/.test(extracted.date || "") ? extracted.date : current.date,
        payee: extracted.payee || current.payee,
        amount: extracted.amount || current.amount,
        category: EXPENSE_CATEGORIES.includes(extracted.category) ? extracted.category : current.category,
        notes: [extracted.notes, extracted.tax ? `Tax: ${formatMoney(extracted.tax)}` : ""]
          .filter(Boolean)
          .join(" · "),
      }));
      setReceiptAttachment({
        name: file.name || "Camera receipt",
        path: result.receiptPath || null,
        stored: result.stored,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
      setReceiptNotice(
        result.stored
          ? "Receipt extracted and stored privately. Review the details before saving."
          : "Receipt extracted. Add Supabase Storage settings to retain the image online."
      );
    } catch (error) {
      setReceiptNotice(error.message || "Could not read receipt.");
    } finally {
      setIsAnalyzingReceipt(false);
      if (receiptInputRef.current) receiptInputRef.current.value = "";
    }
  }

  async function startRemoteCapture() {
    setReceiptNotice("");
    try {
      const response = await fetchWithTimeout(`${API_BASE_URL}/api/receipt-captures`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
      const session = await response.json();
      const captureUrl = `${PUBLIC_APP_URL}/?receiptCapture=${encodeURIComponent(session.token)}`;
      const qrDataUrl = await QRCode.toDataURL(captureUrl, {
        width: 280,
        margin: 1,
        color: { dark: "#292721", light: "#faf8f1" },
      });
      setRemoteCapture({ token: session.token, captureUrl, qrDataUrl });
    } catch (error) {
      setReceiptNotice(error.message || "Could not start iPhone capture.");
    }
  }

  async function uploadRemoteReceipt(file) {
    if (!file || !captureToken) return;
    setMobileCaptureStatus("Uploading and reading receipt…");
    try {
      const formData = new FormData();
      formData.append("receipt", file, file.name || `iphone-receipt-${Date.now()}.jpg`);
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/api/public/receipt-captures/${encodeURIComponent(captureToken)}`,
        { method: "POST", body: formData },
        120000
      );
      if (!response.ok) throw new Error(await response.text());
      setMobileCaptureStatus("Receipt sent. You can return to your computer.");
    } catch (error) {
      setMobileCaptureStatus(error.message || "Could not send receipt.");
    }
  }

  function updateConnectionForm(field, value) {
    setConnectionForm((current) => ({ ...current, [field]: value }));
  }

  function resetConnectionForm() {
    setEditingConnectionId(null);
    setConnectionForm({
      type: "Bank",
      institution: "",
      name: "",
      last4: "",
      balance: "",
    });
  }

  function saveConnection() {
    if (!connectionForm.institution || !connectionForm.name) {
      alert("Add an institution and account nickname first.");
      return;
    }

    if (editingConnectionId) {
      const previous = bankAccounts.find(
        (account) => account.id === editingConnectionId
      );
      const updatedAccount = {
        ...previous,
        ...connectionForm,
        balance: Number(connectionForm.balance || 0),
        lastSync: previous?.lastSync || new Date().toLocaleString(),
      };

      saveBankAccounts(
        bankAccounts.map((account) =>
          account.id === editingConnectionId ? updatedAccount : account
        )
      );

      if (previous?.name && previous.name !== updatedAccount.name) {
        saveBankTransactions(
          bankTransactions.map((transaction) =>
            transaction.account === previous.name
              ? { ...transaction, account: updatedAccount.name }
              : transaction
          )
        );
      }
    } else {
      saveBankAccounts([
        {
          id: Date.now(),
          ...connectionForm,
          balance: Number(connectionForm.balance || 0),
          lastSync: "Manual connection",
        },
        ...bankAccounts,
      ]);
    }

    setBankNotice(`${connectionForm.name} connection saved.`);
    resetConnectionForm();
  }

  function editConnection(account) {
    setEditingConnectionId(account.id);
    setConnectionForm({
      type: account.type || "Bank",
      institution: account.institution || "",
      name: account.name || "",
      last4: account.last4 || "",
      balance: account.balance || "",
    });
  }

  function removeConnection(account) {
    const removeTransactions = window.confirm(
      `Remove ${account.name}? Select OK to also remove its imported transactions. Select Cancel to remove only the connection.`
    );
    saveBankAccounts(bankAccounts.filter((item) => item.id !== account.id));

    if (removeTransactions) {
      saveBankTransactions(
        bankTransactions.filter((transaction) => transaction.account !== account.name)
      );
    }

    if (editingConnectionId === account.id) {
      resetConnectionForm();
    }

    setBankNotice(`${account.name} connection removed.`);
  }

  function addExpense() {
    const amount = Number(expenseForm.amount);

    if (!expenseForm.payee || !amount) {
      alert("Add a payee and amount first.");
      return;
    }

    if (editingExpenseId) {
      const previous = expenses.find((expense) => expense.id === editingExpenseId);
      const updatedExpense = {
        ...previous,
        ...expenseForm,
        amount: Math.abs(amount),
        status: "Recorded",
        receipt: receiptAttachment || previous?.receipt || null,
      };
      saveExpenses(
        expenses.map((expense) =>
          expense.id === editingExpenseId ? updatedExpense : expense
        )
      );
      setLastExpenseAction({ type: "edit", before: previous });
      setEditingExpenseId(null);
    } else {
      const expense = {
        id: Date.now(),
        ...expenseForm,
        amount: Math.abs(amount),
        status: "Recorded",
        source: "Manual",
        receipt: receiptAttachment,
      };
      saveExpenses([expense, ...expenses]);
      setLastExpenseAction({ type: "add", expense });
    }

    setExpenseForm({
      date: new Date().toISOString().slice(0, 10),
      payee: "",
      category: "Uncategorized",
      amount: "",
      paymentAccount: expenseForm.paymentAccount,
      notes: "",
    });
    setReceiptAttachment(null);
    setReceiptNotice("");
  }

  function editExpense(expense) {
    setEditingExpenseId(expense.id);
    setExpenseForm({
      date: expense.date,
      payee: expense.payee,
      category: expense.category,
      amount: expense.amount,
      paymentAccount: expense.paymentAccount,
      notes: expense.notes || "",
    });
    setReceiptAttachment(expense.receipt || null);
  }

  function cancelExpenseEdit() {
    setEditingExpenseId(null);
    setReceiptAttachment(null);
    setReceiptNotice("");
    setExpenseForm({
      date: new Date().toISOString().slice(0, 10),
      payee: "",
      category: "Uncategorized",
      amount: "",
      paymentAccount: expenseForm.paymentAccount,
      notes: "",
    });
  }

  function undoExpenseAction() {
    if (!lastExpenseAction) return;

    if (lastExpenseAction.type === "add") {
      saveExpenses(
        expenses.filter((expense) => expense.id !== lastExpenseAction.expense.id)
      );
    }

    if (lastExpenseAction.type === "delete") {
      saveExpenses([lastExpenseAction.expense, ...expenses]);
    }

    if (lastExpenseAction.type === "edit") {
      saveExpenses(
        expenses.map((expense) =>
          expense.id === lastExpenseAction.before.id
            ? lastExpenseAction.before
            : expense
        )
      );
    }

    setLastExpenseAction(null);
    setEditingExpenseId(null);
  }

  function connectBankAccount() {
    const accountName =
      window.prompt("Bank account nickname", "Business Checking") ||
      "Business Checking";
    const balance = Number(
      window.prompt("Current account balance", "4280.45") || 0
    );
    const account = {
      id: Date.now(),
      name: accountName,
      institution: "Connected bank",
      type: "Bank",
      last4: "",
      balance,
      lastSync: new Date().toLocaleString(),
    };
      const imported = SAMPLE_BANK_TRANSACTIONS.map((transaction, index) => ({
      id: Date.now() + index + 1,
      account: accountName,
      category:
        transaction.amount < 0
          ? classifyTransaction(transaction.description)
          : "Income",
      status: "For review",
        ...transaction,
    })).map((transaction) => applyLearnedCategory(transaction, vendorRules));

    saveBankAccounts([account, ...bankAccounts]);
    saveBankTransactions([...imported, ...bankTransactions]);
    setBankNotice(
      "Demo transactions imported. For a real Venmo connection, use a secure bank data provider such as Plaid Link or import Venmo CSV statements."
    );
    setDashboardView("transactions");
    setShowConnectionsModal(false);
  }

  function importBankCsv(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const accountName = file.name.toLowerCase().includes("venmo")
        ? "Venmo"
        : "Imported account";
      const imported = normalizeImportedTransactions(String(reader.result), accountName).map(
        (transaction) => applyLearnedCategory(transaction, vendorRules)
      );

      if (!imported.length) {
        alert("No transactions found in that CSV.");
        return;
      }

      const existingAccount = bankAccounts.find(
        (account) => account.name.toLowerCase() === accountName.toLowerCase()
      );
      const accounts = existingAccount
        ? bankAccounts
        : [
            {
              id: Date.now(),
              name: accountName,
              institution: accountName === "Venmo" ? "Venmo" : "CSV import",
              type: accountName === "Venmo" ? "Debit Card" : "Bank",
              last4: "",
              balance: imported.reduce(
                (sum, transaction) => sum + Number(transaction.amount || 0),
                0
              ),
              lastSync: new Date().toLocaleString(),
            },
            ...bankAccounts,
          ];

      saveBankAccounts(accounts);
      saveBankTransactions([...imported, ...bankTransactions]);
      setBankNotice(`${imported.length} transactions imported from ${file.name}.`);
      setShowConnectionsModal(false);
    };
    reader.readAsText(file);
  }

  async function syncPlaidTransactions(itemId) {
    const res = await fetchWithTimeout(`${API_BASE_URL}/api/plaid/sync-transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(itemId ? { item_id: itemId } : {}),
    });

    if (!res.ok) {
      const message = await res.text();
      throw new Error(message || "Could not sync Plaid transactions.");
    }

    const data = await res.json();
    mergeBankAccounts(data.accounts || []);
    mergeBankTransactions(data.transactions || [], data.removed_transaction_ids || []);
    setBankNotice(
      `${(data.transactions || []).length} Plaid transactions synced from ${(data.accounts || []).length} account(s).`
    );
  }

  async function refreshPlaidTransactions() {
    try {
      const refreshRes = await fetchWithTimeout(
        `${API_BASE_URL}/api/plaid/refresh-transactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        45000
      );

      if (!refreshRes.ok) {
        const message = await refreshRes.text();
        throw new Error(message || "Could not refresh Plaid transactions.");
      }

      const data = await refreshRes.json();
      await syncPlaidTransactions();
      setBankNotice(
        `Refresh requested for ${data.refreshed_items} Plaid connection(s). New available transactions were synced.`
      );
    } catch (err) {
      console.error("Plaid refresh error:", err);
      alert(`Plaid refresh failed: ${err.message}`);
    }
  }

  async function connectWithPlaid() {
    try {
      setIsPlaidConnecting(true);
      await loadPlaidScript();

      const tokenRes = await fetchWithTimeout(`${API_BASE_URL}/api/plaid/create-link-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "willamiko-user" }),
      });

      if (!tokenRes.ok) {
        const message = await tokenRes.text();
        throw new Error(message || "Could not create Plaid Link token.");
      }

      const { link_token: linkToken } = await tokenRes.json();
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          const exchangeRes = await fetchWithTimeout(
            `${API_BASE_URL}/api/plaid/exchange-public-token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                public_token: publicToken,
                institution: metadata?.institution?.name,
              }),
            }
          );

          if (!exchangeRes.ok) {
            const message = await exchangeRes.text();
            throw new Error(message || "Could not exchange Plaid token.");
          }

          const { item_id: itemId } = await exchangeRes.json();
          await syncPlaidTransactions(itemId);
          setShowConnectionsModal(false);
          setIsPlaidConnecting(false);
        },
        onExit: () => {
          setIsPlaidConnecting(false);
        },
      });

      handler.open();
    } catch (err) {
      console.error("Plaid connection error:", err);
      alert(`Plaid connection failed: ${err.message}`);
      setIsPlaidConnecting(false);
    }
  }

  function rememberVendorRule(transaction) {
    if (!transaction.category || transaction.category === "Uncategorized") {
      return;
    }

    const vendorKey = getVendorKey(transaction.description);
    if (!vendorKey) return;
    const shouldRemember = window.confirm(
      `Remember "${transaction.description}" as ${transaction.category} for future transactions?`
    );

    if (!shouldRemember) return;

    const rule = {
      id: vendorKey,
      vendorKey,
      category: transaction.category,
      vendorName: transaction.description,
    };
    const updated = [
      rule,
      ...vendorRules.filter((item) => item.id !== rule.id),
    ];
    saveVendorRules(updated);
  }

  function approveTransactions(transactionsToApprove) {
    const ids = transactionsToApprove.map((transaction) => transaction.id);
    const updatedTransactions = bankTransactions.map((item) =>
      ids.includes(item.id) ? { ...item, status: "Matched" } : item
    );
    const newExpenses = transactionsToApprove
      .filter((transaction) => transaction.amount < 0)
      .map((transaction, index) => ({
        id: Date.now() + index,
        date: transaction.date,
        payee: transaction.description,
        category: transaction.category,
        amount: Math.abs(transaction.amount),
        paymentAccount: transaction.account,
        notes: "Imported from bank feed",
        source: "Bank feed",
        status: "Recorded",
      }));

    transactionsToApprove.forEach(rememberVendorRule);
    saveBankTransactions(updatedTransactions);
    saveExpenses([...newExpenses, ...expenses]);
    setSelectedTransactionIds((current) =>
      current.filter((id) => !ids.includes(id))
    );
  }

  function approveTransaction(transaction) {
    approveTransactions([transaction]);
  }

  function updateTransactionCategory(id, category) {
    const updated = bankTransactions.map((transaction) =>
      transaction.id === id ? { ...transaction, category } : transaction
    );
    saveBankTransactions(updated);
  }

  function toggleTransactionSelection(id) {
    setSelectedTransactionIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  function toggleAllVisibleTransactions() {
    if (allVisibleTransactionsSelected) {
      const visibleIds = selectableTransactions.map((transaction) => transaction.id);
      setSelectedTransactionIds((current) =>
        current.filter((id) => !visibleIds.includes(id))
      );
      return;
    }

    setSelectedTransactionIds((current) =>
      Array.from(
        new Set([
          ...current,
          ...selectableTransactions.map((transaction) => transaction.id),
        ])
      )
    );
  }

  async function categorizeTransactionsWithAi() {
    const selected = selectedTransactionIds.length
      ? filteredTransactions.filter((transaction) =>
          selectedTransactionIds.includes(transaction.id)
        )
      : [];
    const candidates = selected.length
      ? selected
      : filteredTransactions.filter(
          (transaction) =>
            transaction.status !== "Matched" ||
            transaction.category === "Uncategorized"
        );

    if (!candidates.length) {
      setBankNotice("No transactions need AI categorization right now.");
      return;
    }

    try {
      setIsCategorizingTransactions(true);
      const res = await fetchWithTimeout(
        `${API_BASE_URL}/api/ai/categorize-transactions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: candidates }),
        },
        60000
      );

      if (!res.ok) {
        const message = await res.text();
        throw new Error(message || "AI categorization failed.");
      }

      const data = await res.json();
      const suggestions = data.suggestions || [];
      const suggestionById = suggestions.reduce((map, suggestion) => {
        map[suggestion.id] = suggestion;
        return map;
      }, {});
      const updated = bankTransactions.map((transaction) => {
        const suggestion = suggestionById[String(transaction.id)];

        if (!suggestion) return transaction;

        return {
          ...transaction,
          category: suggestion.category,
          categorizedBy: "AI",
        };
      });

      saveBankTransactions(updated);
      setBankNotice(`${suggestions.length} transaction categories suggested by AI.`);
    } catch (err) {
      console.error("AI categorization failed:", err);
      alert(`AI categorization failed: ${err.message}`);
    } finally {
      setIsCategorizingTransactions(false);
    }
  }

  function deleteExpense(id) {
    const expense = expenses.find((item) => item.id === id);
    saveExpenses(expenses.filter((item) => item.id !== id));
    setLastExpenseAction({ type: "delete", expense });
  }

  function saveInvoiceRecord(statusOverride, typeOverride = documentType) {
    const recordType = typeOverride;
    const typeLabel = getDocumentLabel(recordType, "short");
    const recordStatus = normalizeDocumentStatus(
      recordType,
      statusOverride || invoiceStatus
    );
    const recordData = {
      ...getInvoiceData(),
      documentType: recordType,
    };
    const invoice = {
      id: activeInvoice?.id || Date.now(),
      documentType: recordType,
      invoiceNo,
      clientName: clientName || "Untitled",
      date: invoiceDate,
      dueDate,
      total: formatMoney(total),
      status: recordStatus,
      title: `${typeLabel} ${invoiceNo || "No Number"}`,
      data: recordData,
    };
  
    const updated = [
      invoice,
      ...invoices.filter((i) => i.id !== invoice.id),
    ];
  
    setInvoices(updated);
    setDocumentType(recordType);
    setInvoiceStatus(recordStatus);
    lastSavedInvoiceSnapshotRef.current = JSON.stringify(recordData);
  }

  function loadInvoiceRecord(invoice) {
    const data = invoice.data;
  
    setActiveInvoice(invoice);
    setDocumentType(invoice.documentType || data.documentType || "invoice");
    setInvoiceStatus(normalizeDocumentStatus(invoice.documentType, invoice.status));
    setClientName(data.clientName || "");
    setClientEmail(data.clientEmail || "");
    setAddress1(data.address1 || "");
    setAddress2(data.address2 || "");
    setInvoiceNo(data.invoiceNo || "1018");
    setTerms(data.terms || "Due on receipt");
    setInvoiceDate(data.invoiceDate || "2026-01-27");
    setDueDate(data.dueDate || "2026-01-27");
    setNotes(data.notes || "");
    setItems(
      data.items?.map((item) => ({ ...item })) || [
        { date: "2026-01-12", product: "DP PREP", description: "", qty: 1, rate: 400 },
      ]
    );
    setLogo(data.logo || DEFAULT_LOGO);
    setLogoSize(data.logoSize || 80);
    setPdfPreviewUrl(null);
    setHostedPdfUrl(null);
    setPdfThumbnail(null);
    lastSavedInvoiceSnapshotRef.current = JSON.stringify({
      ...data,
      documentType: invoice.documentType || data.documentType || "invoice",
      items: data.items?.map((item) => ({ ...item })) || [],
    });
  }


  function resetInvoice() {
    setDocumentType("invoice");
    setInvoiceStatus("draft");
    setClientName("");
    setClientEmail("");
    setAddress1("");
    setAddress2("");
    setInvoiceNo("1018");
    setTerms("Due on receipt");
    setInvoiceDate("2026-01-27");
    setDueDate("2026-01-27");
    setNotes("");
    
    setLogo(DEFAULT_LOGO);

    setItems([
      { date: "2026-01-12", product: "DP PREP", description: "", qty: 1, rate: 400 },
    ]);
    setEmailTo("");
    setEmailCc("");
    setEmailSubject("");
    setExtraAttachments([]);
    setPdfPreviewUrl(null);
    setHostedPdfUrl(null);
    setPdfThumbnail(null);
    lastSavedInvoiceSnapshotRef.current = null;
    
  }

  function getInvoiceData() {
    return {
      clientName,
      clientEmail,
      documentType,
      address1,
      address2,
      invoiceNo,
      terms,
      invoiceDate,
      dueDate,
      notes,
      items: items.map((item) => ({ ...item })),
      logo,
      logoSize,
    };
  }

  function hasUnsavedInvoiceChanges() {
    if (lastSavedInvoiceSnapshotRef.current === null) return true;
    return lastSavedInvoiceSnapshotRef.current !== JSON.stringify(getInvoiceData());
  }
  
  function saveDraft() {
    try {
      alert("Save Draft clicked.");
  
      const draftName = `Invoice ${invoiceNo || "No Number"} - ${
        clientName || "Untitled"
      }`;
  
      const newDraft = {
        id: Date.now(),
        name: draftName,
        createdAt: new Date().toLocaleString(),
        data: getInvoiceData(),
      };
  
      setDrafts([newDraft, ...drafts]);
  
      alert(`Draft saved:\n${draftName}`);
    } catch (err) {
      console.error("Save draft failed:", err);
      alert("Draft failed to save. Check console.");
    }
  }
  
  function loadDraft(draft) {
    const data = draft.data;
  
    setDocumentType(data.documentType || "invoice");
    setClientName(data.clientName || "");
    setClientEmail(data.clientEmail || "");
    setAddress1(data.address1 || "");
    setAddress2(data.address2 || "");
    setInvoiceNo(data.invoiceNo || "1018");
    setTerms(data.terms || "Due on receipt");
    setInvoiceDate(data.invoiceDate || "2026-01-27");
    setDueDate(data.dueDate || "2026-01-27");
    setNotes(data.notes || "");
    setItems(data.items || [
      { date: "2026-01-12", product: "DP PREP", description: "", qty: 1, rate: 400 },
    ]);
    setLogo(data.logo || DEFAULT_LOGO);
    setLogoSize(data.logoSize || 80);
  }
  
  function openDrafts() {
    try {
      if (!drafts.length) {
        alert("No drafts saved yet.");
        return;
      }
  
      const list = drafts
        .map((draft, index) => `${index + 1}. ${draft.name} — ${draft.createdAt}`)
        .join("\n");
  
      const choice = window.prompt(`Choose a draft number:\n\n${list}`);
  
      if (!choice) return;
  
      const selectedDraft = drafts[Number(choice) - 1];
  
      if (!selectedDraft) {
        alert("Invalid draft number.");
        return;
      }
  
      loadDraft(selectedDraft);
      alert(`Loaded draft:\n${selectedDraft.name}`);
    } catch (err) {
      console.error("Load draft failed:", err);
      alert("Draft failed to load. Check console.");
    }
  }


  async function openInvoicePdf() {
    let url = pdfPreviewUrl;
  
    if (!url) {
      const pdfBlob = await generatePdfBlob();
      url = URL.createObjectURL(pdfBlob);
      setPdfPreviewUrl(url);
    }
  
    const pdfWindow = window.open("", "_blank");
  
    if (!pdfWindow) {
      alert("Popup blocked. Please allow popups.");
      return;
    }
  
    pdfWindow.document.open();
    pdfWindow.document.write(`
      <html>
        <head>
          <title>${getDocumentLabel(documentType, "short")}_${invoiceNo}.pdf</title>
        </head>
        <body style="margin:0">
          <iframe
            src="${url}"
            style="width:100vw;height:100vh;border:none;"
          ></iframe>
        </body>
      </html>
    `);
    pdfWindow.document.close();
  }

  
  function formatMoney(amount) {
    return Number(amount || 0).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
  }

  function updateItem(index, field, value) {
    setItems((currentItems) =>
      currentItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      )
    );
  }

  function addLine() {
    setItems([
      ...items,
      { date: "", product: "Services", description: "", qty: 1, rate: 400 },
    ]);
  }

  
  function removeLine(index) {
    setItems(items.filter((_, i) => i !== index));
  }

  function openPdfPreview() {
    setShowPdfPreview(true);
  }

  async function downloadPdfFromPreview() {
    const pdfBlob = await generatePdfBlob();
  
    const url = URL.createObjectURL(pdfBlob);
    const link = document.createElement("a");
  
    link.href = url;
    link.download = `${getDocumentLabel(documentType, "short")}_${invoiceNo}.pdf`;
    document.body.appendChild(link);
    link.click();
  
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  
    setShowPdfPreview(false);
  }

  async function generatePdfBlob() {
    const element = invoiceRef.current;

    const options = {
      margin: 0,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        onclone: (clonedDoc) => {
          clonedDoc
            .querySelectorAll(".add-line-btn, .remove-btn, .actions, .status, .logo-slider, .customer-picker")
            .forEach((el) => (el.style.display = "none"));

            // remove bill-to underline/input lines in generated PDF
clonedDoc.querySelectorAll(".bill-line, .bill-to-fields input").forEach((el) => {
  el.style.border = "none";
  el.style.borderBottom = "none";
  el.style.outline = "none";
  el.style.boxShadow = "none";
  el.style.background = "transparent";
});
  
          clonedDoc.querySelectorAll(".logo-box").forEach((el) => {
            el.style.border = "none";
            el.style.background = "transparent";
          });
  
          clonedDoc.querySelectorAll(".logo-box span").forEach((el) => {
            el.style.display = "none";
          });
  
          clonedDoc.querySelectorAll(".notes-box").forEach((box) => {
            const textarea = box.querySelector("textarea");
          
            if (!textarea || textarea.value.trim() === "") {
              box.style.display = "none";
              return;
            }
          
            const div = clonedDoc.createElement("div");
            div.className = "pdf-notes-text";
            div.innerHTML = textarea.value
              .split("\n")
              .map((line) => line || "&nbsp;")
              .join("<br>");
          
            textarea.replaceWith(div);
          });

        },
      },
      jsPDF: {
        unit: "in",
        format: "letter",
        orientation: "portrait",
      },
    };
  
    return html2pdf().set(options).from(element).outputPdf("blob");
  }
  async function createHostedPdfLink(pdfBlob) {
    const formData = new FormData();
  
    formData.append(
      "invoicePdf",
      pdfBlob,
      `${getDocumentLabel(documentType, "short")}_${invoiceNo}_from_WILLAMIKO_LLC.pdf`
    );
    
    if (emailLogo) {
      formData.append("logo", emailLogo);
    } else if (logo) {
      formData.append("logo", logo);
    }

    let res;

    try {
      res = await fetchWithTimeout(`${API_BASE_URL}/host-invoice-pdf`, {
        method: "POST",
        body: formData,
      });
    } catch (err) {
      throw new Error(getRequestErrorMessage(err, "Hosting the invoice PDF"));
    }

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(errorText || "Could not host invoice PDF.");
    }
  
    const data = await res.json();
    setHostedPdfUrl(data.url);
  
    return data.url;
  }

  async function generateInvoiceThumbnail() {
    const element = invoiceRef.current;
  
    const canvas = await html2canvas(element, {
      scale: 0.4,
      backgroundColor: "#ffffff",
      useCORS: true,
      onclone: (clonedDoc) => {
        clonedDoc
          .querySelectorAll(".add-line-btn, .remove-btn, .actions, .status, .logo-slider, .customer-picker")
          .forEach((el) => {
            el.style.display = "none";
          });

          // remove input borders/lines in PDF/email version
clonedDoc.querySelectorAll("input, textarea, select").forEach((el) => {
  el.style.border = "none";
  el.style.outline = "none";
  el.style.boxShadow = "none";
  el.style.background = "transparent";
});

// remove bill-to underline lines
clonedDoc.querySelectorAll("input").forEach((el) => {
  el.style.borderBottom = "none";
});
  
        clonedDoc.querySelectorAll(".logo-box").forEach((el) => {
          el.style.border = "none";
          el.style.background = "transparent";
        });
  
        clonedDoc.querySelectorAll(".logo-box span").forEach((el) => {
          el.style.display = "none";
        });
  
        clonedDoc.querySelectorAll(".notes-box").forEach((box) => {
          const textarea = box.querySelector("textarea");
          if (!textarea || textarea.value.trim() === "") {
            box.style.display = "none";
          }
        });
      },
    });
  
    return canvas.toDataURL("image/png");

  }


  async function sendEmail() {
    if (!emailTo.trim()) {
      alert("Please enter a To email address.");
      return;
    }
  
    try {
      setIsSendingEmail(true);
      setStatus("");
  
      const pdfBlob = await generatePdfBlob();
const finalHostedPdfUrl = hostedPdfUrl || (await createHostedPdfLink(pdfBlob));

const formData = new FormData();
      const extractedEmail =
  emailTo ||
  (clientName.match(/[^\s]+@[^\s]+\.[^\s]+/) || [])[0] ||
  "";

formData.append("to", extractedEmail);
      formData.append("cc", emailCc);
      formData.append("from", emailFrom);
      formData.append(
        "subject",
        emailSubject ||
          `${getDocumentLabel(documentType, "short")} ${invoiceNo} from WILLAMIKO .LLC`
      );
      formData.append("clientName", clientName);
      formData.append("total", formatMoney(total));
      formData.append("notes", notes);
      formData.append("hostedPdfUrl", finalHostedPdfUrl);
      formData.append(
        "invoicePdf",
        pdfBlob,
        `${getDocumentLabel(documentType, "short")}_${invoiceNo}_from_WILLAMIKO_LLC.pdf`
      );
  
      extraAttachments.forEach((file) => {
        formData.append("attachments", file);
      });
  
      let res;

      try {
        res = await fetchWithTimeout(`${API_BASE_URL}/send-email`, {
          method: "POST",
          body: formData,
        });
      } catch (err) {
        throw new Error(
          getRequestErrorMessage(
            err,
            `Sending the ${getDocumentLabel(documentType, "lower")} email`
          )
        );
      }
  
      if (!res.ok) {
        const errorText = await res.text();
        console.error("Email failed:", errorText);
        alert(`Email failed: ${errorText || "Check your server terminal."}`);
        setStatus("");
        setIsSendingEmail(false);
        return;
      }
  
      setIsSendingEmail(false);
setShowEmailPreview(false);

setTimeout(() => {
  setShowSentConfirmation(true);
}, 150);
    } catch (err) {
      console.error("Send email error:", err);
      const message = getRequestErrorMessage(
        err,
        `Sending the ${getDocumentLabel(documentType, "lower")} email`
      );
      alert(`Email failed: ${message}`);
      setStatus("");
      setIsSendingEmail(false);
    }
  }


  if (captureToken) {
    return (
      <div className="mobile-capture-page">
        <div className="mobile-capture-card">
          <span>Willamiko receipt capture</span>
          <h1>Take a receipt photo</h1>
          <p>Use the rear camera and fill the frame with the entire receipt.</p>
          <label className="mobile-capture-button">
            Open iPhone camera
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(event) => uploadRemoteReceipt(event.target.files?.[0])}
            />
          </label>
          {mobileCaptureStatus && <div className="mobile-capture-status">{mobileCaptureStatus}</div>}
        </div>
      </div>
    );
  }

  if (screen === "login") {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={signIn}>
          <h1>willamiko accounter</h1>
          <p>Sign in to your private business account.</p>
          <label>
            Username
            <input
              autoComplete="username"
              value={loginForm.username}
              onChange={(event) =>
                setLoginForm((current) => ({ ...current, username: event.target.value }))
              }
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={loginForm.password}
              onChange={(event) =>
                setLoginForm((current) => ({ ...current, password: event.target.value }))
              }
              required
            />
          </label>
          {loginError && <div className="login-error">{loginError}</div>}
          <button type="submit" disabled={isSigningIn}>
            {isSigningIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }
  
  if (screen === "dashboard") {
    const totalDrafts = invoices.filter((i) => i.status === "draft").length;
    const totalSent = invoices.filter((i) => i.status === "sent").length;
    const totalQuotes = invoices.filter((i) => i.documentType === "quote").length;
    const totalExpenseDocs = invoices.filter((i) => i.documentType === "expense").length;
    const categoryTotals = EXPENSE_CATEGORIES.map((category) => ({
      category,
      total: expenses
        .filter((expense) => expense.category === category)
        .reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
    })).filter((row) => row.total > 0);
  
    return (
      <div className="qb-dashboard">
        <div className="qb-sidebar">
          <div className="qb-brand">
            <div className="qb-logo">W</div>
            <div>
              <strong>Willamiko</strong>
              <span>Business</span>
            </div>
          </div>
          {[
            ["overview", "Dashboard"],
            ["invoices", "Invoices"],
            ["expenses", "Expenses"],
            ["transactions", "Transactions"],
            ["reports", "Reports"],
            ["budgets", "Budgets"],
            ...(currentUser?.role === "admin" ? [["accounts", "Accounts"]] : []),
          ].map(([view, label]) => (
            <button
              className={`qb-nav ${dashboardView === view ? "active" : ""}`}
              key={view}
              onClick={() => setDashboardView(view)}
            >
              {label}
            </button>
          ))}
          <div className="qb-account-footer">
            <span>{currentUser?.username}</span>
            <button
              type="button"
              onClick={() => {
                setPasswordNotice("");
                setShowPasswordModal(true);
              }}
            >
              Change password
            </button>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        </div>
  
        <div className="qb-main">
          <div className="qb-top">
            <div>
              <h1>
                {dashboardView === "overview"
                  ? "Business overview"
                  : dashboardView.charAt(0).toUpperCase() + dashboardView.slice(1)}
              </h1>
            </div>
  
            {dashboardView === "invoices" && (
              <div className="qb-top-actions">
                {invoiceTab === "customers" ? (
                  <button
                    className="qb-new-btn"
                    onClick={() => {
                      resetCustomerForm();
                      setShowCustomerEditor(true);
                    }}
                  >
                    + Add contact
                  </button>
                ) : (
                  <details className="qb-new-menu" ref={newMenuRef}>
                    <summary className="qb-new-btn">
                      <span>＋ New</span>
                      <span className="qb-new-chevron">⌄</span>
                    </summary>
                    <div className="qb-new-menu-options">
                      {[
                        ["invoice", "Invoice", "Create and send a bill"],
                        ["quote", "Quote", "Prepare an estimate"],
                        ["expense", "Expense", "Record a business cost"],
                      ].map(([type, label, description]) => (
                        <button
                          type="button"
                          key={type}
                          onClick={() => {
                            resetInvoice();
                            setDocumentType(type);
                            setActiveInvoice(null);
                            setScreen("invoice");
                          }}
                        >
                          <span className={`qb-new-type-icon ${type}`}>
                            {label.charAt(0)}
                          </span>
                          <span>
                            <strong>{label}</strong>
                            <small>{description}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
  
          <div className="qb-stats">
            <div>
              <strong>{formatMoney(revenueTotal)}</strong>
              <span>Revenue</span>
            </div>
  
            <div>
              <strong>{formatMoney(expenseTotal)}</strong>
              <span>Expenses</span>
            </div>
  
            <div>
              <strong>{formatMoney(revenueTotal - expenseTotal)}</strong>
              <span>Net income</span>
            </div>

            <div>
              <strong>{reviewCount}</strong>
              <span>Transactions review</span>
            </div>
          </div>

          {dashboardView === "overview" && (
            <div className="accounting-grid">
              <div className="accounting-panel">
                <h2>Money in and out</h2>
                <div className="report-bars">
                  <div>
                    <span>Income</span>
                    <strong>{formatMoney(revenueTotal)}</strong>
                  </div>
                  <div>
                    <span>Expenses</span>
                    <strong>{formatMoney(expenseTotal)}</strong>
                  </div>
                  <div>
                    <span>Connected cash</span>
                    <strong>{formatMoney(connectedBalance)}</strong>
                  </div>
                </div>
              </div>

              <div className="accounting-panel">
                <h2>Needs attention</h2>
                <div className="attention-list">
                  <button onClick={() => setDashboardView("transactions")}>
                    {reviewCount} transactions ready to review
                  </button>
                  <button onClick={() => setDashboardView("expenses")}>
                    {uncategorizedCount} uncategorized bank transactions
                  </button>
                  <button onClick={() => setDashboardView("invoices")}>
                    {totalDrafts} invoice drafts, {totalSent} sent invoices, {totalQuotes} quotes, and {totalExpenseDocs} expenses
                  </button>
                </div>
              </div>
            </div>
          )}

          {dashboardView === "invoices" && (
            <>
              <div className="qb-tabs">
                <button
                  className={invoiceTab === "invoices" ? "active" : ""}
                  onClick={() => setInvoiceTab("invoices")}
                >
                  Invoices
                </button>
                <button
                  className={invoiceTab === "customers" ? "active" : ""}
                  onClick={() => setInvoiceTab("customers")}
                >
                  Customers
                </button>
                <button
                  className={invoiceTab === "products" ? "active" : ""}
                  onClick={() => setInvoiceTab("products")}
                >
                  Products and Services
                </button>
              </div>

              {invoiceTab === "invoices" && (
                <div className="qb-table-card">
                  <div className="qb-table-head invoices">
                    {[
                      ["type", "Type"],
                      ["number", "No."],
                      ["customer", "Customer / Project"],
                      ["date", "Date"],
                      ["total", "Total"],
                      ["status", "Status"],
                    ].map(([key, label]) => (
                      <button
                        type="button"
                        className={`invoice-sort-header ${invoiceSort.key === key ? "active" : ""}`}
                        key={key}
                        aria-sort={
                          invoiceSort.key === key
                            ? invoiceSort.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortInvoicesBy(key)}
                      >
                        <span>{label}</span>
                        {invoiceSort.key === key && (
                          <span className="invoice-sort-arrow" aria-hidden="true">
                            {invoiceSort.direction === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                      </button>
                    ))}
                    <div>Actions</div>
                  </div>

                  {invoices.length === 0 ? (
                    <div className="qb-empty">
                      No invoices yet. Click New to create one.
                    </div>
                  ) : (
                    sortedInvoices.map((inv) => (
                      <div
                        className="qb-table-row invoices"
                        key={inv.id}
                        onClick={() => setActiveInvoice(inv)}
                      >
                        <div className={inv.documentType === "expense" ? "qb-doc-type expense" : undefined}>
                          {getDocumentLabel(inv.documentType, "short")}
                        </div>
                        <div>{inv.invoiceNo}</div>
                        <div className="invoice-customer-name">
                          {inv.clientName || "Untitled"}
                        </div>
                        <div>{inv.date}</div>
                        <div>{inv.total}</div>
                        <div onClick={(e) => e.stopPropagation()}>
                          <details className="invoice-status-menu">
                              <summary className={`invoice-status-pill ${normalizeDocumentStatus(inv.documentType, inv.status)}`}>
                                <span className="invoice-status-dot"></span>
                                <span>{normalizeDocumentStatus(inv.documentType, inv.status)}</span>
                                <span className="invoice-status-chevron">⌄</span>
                              </summary>
                              <div className="invoice-status-options">
                                {getDocumentStatuses(inv.documentType).map((nextStatus) => (
                                  <button
                                    type="button"
                                    className={normalizeDocumentStatus(inv.documentType, inv.status) === nextStatus ? "selected" : ""}
                                    key={nextStatus}
                                    onClick={(event) => {
                                      const updated = invoices.map((invoice) =>
                                        invoice.id === inv.id
                                          ? { ...invoice, status: nextStatus }
                                          : invoice
                                      );
                                      setInvoices(updated);
                                      event.currentTarget.closest("details")?.removeAttribute("open");
                                    }}
                                  >
                                    <span className={`invoice-status-dot ${nextStatus}`}></span>
                                    <span>{nextStatus}</span>
                                    {normalizeDocumentStatus(inv.documentType, inv.status) === nextStatus && <span className="status-check">✓</span>}
                                  </button>
                                ))}
                              </div>
                            </details>
                        </div>
                        <div className="qb-action-dropdown" onClick={(e) => e.stopPropagation()}>
                          <span className="qb-action-trigger">...</span>
                          <div className="qb-action-menu">
                            <div
                              onClick={() => {
                                loadInvoiceRecord(inv);
                                setScreen("invoice");
                              }}
                            >
                              Edit
                            </div>
                            <div
                              onClick={() => {
                                const copy = {
                                  ...inv,
                                  id: Date.now(),
                                  invoiceNo: `${inv.invoiceNo}-COPY`,
                                  status: "draft",
                                };
                                const updated = [copy, ...invoices];
                                setInvoices(updated);
                              }}
                            >
                              Duplicate
                            </div>
                            <div
                              className="danger"
                              onClick={() => {
                                const updated = invoices.filter((i) => i.id !== inv.id);
                                setInvoices(updated);
                              }}
                            >
                              Delete
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {invoiceTab === "customers" && (
                <div className="accounting-stack">
                  <div className="qb-table-card customer-table-card">
                    <div className="qb-table-head customers">
                      <div>Name</div>
                      <div>Contact</div>
                      <div>Address</div>
                      <div>Company / Notes</div>
                      <div>Actions</div>
                    </div>

                    {customerRows.length === 0 ? (
                      <div className="qb-empty">
                        No contacts yet. Use Add contact to create your address book.
                      </div>
                    ) : (
                      customerRows.map((customer) => (
                        <div className="qb-table-row customers" key={customer.id}>
                          <div>
                            <strong>{customer.name}</strong>
                            <span>{customer.company || customer.address1 || "Customer"}</span>
                          </div>
                          <div>
                            <span>{customer.email || "No email"}</span>
                            <span>{customer.phone || "No phone"}</span>
                          </div>
                          <div>
                            <span>{customer.address1 || "No address"}</span>
                            <span>{customer.address2 || ""}</span>
                          </div>
                          <div>
                            <span>{customer.company || "No company"}</span>
                            <span>{customer.notes || ""}</span>
                          </div>
                          <div className="customer-actions">
                            <button onClick={() => editCustomer(customer)}>Edit</button>
                            {customer.source === "saved" && (
                              <button
                                className="danger"
                                onClick={() => deleteCustomer(customer.id)}
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {showCustomerEditor && (
                    <div
                      className="qb-modal customer-editor-modal"
                      onClick={() => {
                        resetCustomerForm();
                        setShowCustomerEditor(false);
                      }}
                    >
                      <div
                        className="customer-editor-card"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="customer-editor-title"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="customer-editor-head">
                          <div>
                            <span>Address book</span>
                            <h2 id="customer-editor-title">
                              {editingCustomerId ? "Edit contact" : "Add contact"}
                            </h2>
                          </div>
                          <button
                            type="button"
                            aria-label="Close"
                            onClick={() => {
                              resetCustomerForm();
                              setShowCustomerEditor(false);
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <div className="customer-editor-grid">
                          <label>
                            <span>Name</span>
                            <input value={customerForm.name} onChange={(e) => updateCustomerForm("name", e.target.value)} />
                          </label>
                          <label>
                            <span>Company</span>
                            <input value={customerForm.company} onChange={(e) => updateCustomerForm("company", e.target.value)} />
                          </label>
                          <label>
                            <span>Email</span>
                            <input type="email" value={customerForm.email} onChange={(e) => updateCustomerForm("email", e.target.value)} />
                          </label>
                          <label>
                            <span>Phone</span>
                            <input value={customerForm.phone} onChange={(e) => updateCustomerForm("phone", e.target.value)} />
                          </label>
                          <label className="wide">
                            <span>Address line 1</span>
                            <input value={customerForm.address1} onChange={(e) => updateCustomerForm("address1", e.target.value)} />
                          </label>
                          <label className="wide">
                            <span>Address line 2</span>
                            <input value={customerForm.address2} onChange={(e) => updateCustomerForm("address2", e.target.value)} />
                          </label>
                          <label className="wide">
                            <span>Notes</span>
                            <textarea value={customerForm.notes} onChange={(e) => updateCustomerForm("notes", e.target.value)} />
                          </label>
                        </div>
                        <div className="customer-editor-actions">
                          <button type="button" className="secondary" onClick={() => setShowCustomerEditor(false)}>Cancel</button>
                          <button type="button" onClick={saveCustomer}>Save contact</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {invoiceTab === "products" && (
                <div className="qb-table-card">
                  <div className="qb-empty">
                    Products and services will use the invoice line items you add.
                  </div>
                </div>
              )}
            </>
          )}

          {dashboardView === "expenses" && (
            <div className="accounting-stack">
              <div className="receipt-capture-card">
                <div className="receipt-capture-copy">
                  <span>Receipt assistant</span>
                  <h2>Photograph or upload a receipt</h2>
                  <p>AI fills the expense fields. Review them before saving.</p>
                </div>
                <div className="receipt-actions">
                  <input
                    ref={receiptInputRef}
                    className="receipt-file-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                    capture="environment"
                    onChange={(event) => analyzeReceipt(event.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="qb-new-btn"
                    disabled={isAnalyzingReceipt}
                    onClick={() => receiptInputRef.current?.click()}
                  >
                    {isAnalyzingReceipt ? "Reading…" : "Upload / take photo"}
                  </button>
                  <button type="button" className="receipt-secondary" onClick={startRemoteCapture}>
                    Use iPhone
                  </button>
                </div>
                {(receiptAttachment || receiptNotice) && (
                  <div className="receipt-review">
                    {receiptAttachment?.previewUrl && (
                      <img src={receiptAttachment.previewUrl} alt="Receipt preview" />
                    )}
                    <div>
                      {receiptAttachment && <strong>{receiptAttachment.name}</strong>}
                      <span>{receiptNotice}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="expense-composer">
                <input
                  type="date"
                  value={expenseForm.date}
                  onChange={(e) => updateExpenseForm("date", e.target.value)}
                />
                <input
                  value={expenseForm.payee}
                  onChange={(e) => updateExpenseForm("payee", e.target.value)}
                  placeholder="Payee"
                />
                <select
                  value={expenseForm.category}
                  onChange={(e) => updateExpenseForm("category", e.target.value)}
                >
                  {EXPENSE_CATEGORIES.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={expenseForm.amount}
                  onChange={(e) => updateExpenseForm("amount", e.target.value)}
                  placeholder="Amount"
                />
                <input
                  value={expenseForm.paymentAccount}
                  onChange={(e) => updateExpenseForm("paymentAccount", e.target.value)}
                  placeholder="Account"
                />
                <button onClick={addExpense}>
                  {editingExpenseId ? "Save edits" : "Add expense"}
                </button>
                {editingExpenseId && (
                  <button className="quiet-action" onClick={cancelExpenseEdit}>
                    Cancel
                  </button>
                )}
                {lastExpenseAction && (
                  <button className="quiet-action" onClick={undoExpenseAction}>
                    Undo
                  </button>
                )}
              </div>

              <div className="qb-table-card">
                <div className="qb-table-head expenses">
                  <div>Date</div>
                  <div>Payee</div>
                  <div>Category</div>
                  <div>Account</div>
                  <div>Source</div>
                  <div>Amount</div>
                  <div>Actions</div>
                </div>
                {expenses.length === 0 ? (
                  <div className="qb-empty">No expenses yet.</div>
                ) : (
                  expenses.map((expense) => (
                    <div className="qb-table-row expenses" key={expense.id}>
                      <div>{expense.date}</div>
                      <div>{expense.payee}</div>
                      <div>{expense.category}</div>
                      <div>{expense.paymentAccount}</div>
                      <div>{expense.source}</div>
                      <div>{formatMoney(expense.amount)}</div>
                      <div className="row-actions">
                        <button onClick={() => editExpense(expense)}>Edit</button>
                        {expense.receipt && <span className="receipt-badge">Receipt</span>}
                        <button className="text-danger" onClick={() => deleteExpense(expense.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {remoteCapture && (
                <div className="qb-modal remote-capture-modal" onClick={() => setRemoteCapture(null)}>
                  <div className="remote-capture-card" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="invoice-action-close"
                      aria-label="Close"
                      onClick={() => setRemoteCapture(null)}
                    >
                      ×
                    </button>
                    <span>Use iPhone</span>
                    <h2>Scan to photograph receipt</h2>
                    <p>Open the Camera app on your iPhone and point it at this code.</p>
                    <img src={remoteCapture.qrDataUrl} alt="One-time iPhone receipt capture QR code" />
                    <small>Waiting for photo · Link expires in 10 minutes</small>
                  </div>
                </div>
              )}
            </div>
          )}

          {dashboardView === "transactions" && (
            <div className="accounting-stack">
              {bankNotice && <div className="bank-notice">{bankNotice}</div>}

              <div className="bank-cards">
                {bankAccounts.length === 0 ? (
                  <button
                    className="bank-card add"
                    onClick={() => setShowConnectionsModal(true)}
                  >
                    Manage bank or card connections
                  </button>
                ) : (
                  bankAccounts.map((account) => (
                    <div className="bank-card" key={account.id}>
                      <span>{account.type || "Bank"} · {account.institution}</span>
                      <strong>{account.name}</strong>
                      {account.last4 && <small>Ending in {account.last4}</small>}
                      <b>{formatMoney(account.balance)}</b>
                      <small>Last sync {account.lastSync}</small>
                    </div>
                  ))
                )}
              </div>

              <div className="qb-table-card">
                <div className="transactions-table-actions">
                  <div className="transaction-view-switcher">
                    {[
                      ["review", "To review"],
                      ["approved", "Approved"],
                      ["all", "All"],
                    ].map(([view, label]) => (
                      <button
                        className={transactionView === view ? "active" : ""}
                        key={view}
                        onClick={() => {
                          setTransactionView(view);
                          setSelectedTransactionIds([]);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    className="qb-new-btn secondary"
                    onClick={toggleAllVisibleTransactions}
                    disabled={selectableTransactions.length === 0}
                  >
                    {allVisibleTransactionsSelected ? "Deselect all" : "Select all"}
                  </button>
                  {selectedTransactionIds.length > 0 && (
                    <button
                      className="qb-new-btn secondary"
                      onClick={() =>
                        approveTransactions(
                          bankTransactions.filter((transaction) =>
                            selectedTransactionIds.includes(transaction.id) &&
                            transaction.status !== "Matched"
                          )
                        )
                      }
                    >
                      Add selected
                    </button>
                  )}
                  <button
                    className="qb-new-btn secondary"
                    disabled={isCategorizingTransactions}
                    onClick={categorizeTransactionsWithAi}
                  >
                    {isCategorizingTransactions ? "Categorizing..." : "AI categorize"}
                  </button>
                  <button
                    className="qb-new-btn"
                    onClick={() => setShowConnectionsModal(true)}
                  >
                    Manage connections
                  </button>
                </div>
                <div className="qb-table-head banking">
                  <input
                    type="checkbox"
                    checked={allVisibleTransactionsSelected}
                    disabled={selectableTransactions.length === 0}
                    onChange={toggleAllVisibleTransactions}
                  />
                  <div>Date</div>
                  <div>Description</div>
                  <div>Account</div>
                  <div>Category</div>
                  <div>Amount</div>
                  <div>Status</div>
                  <div>Action</div>
                </div>
                {filteredTransactions.length === 0 ? (
                  <div className="qb-empty">
                    {bankTransactions.length === 0
                      ? "Add a connection or import a CSV to classify transactions."
                      : "No transactions in this view."}
                  </div>
                ) : (
                  filteredTransactions.map((transaction) => (
                    <div className="qb-table-row banking" key={transaction.id}>
                      <input
                        type="checkbox"
                        checked={selectedTransactionIds.includes(transaction.id)}
                        disabled={transaction.status === "Matched"}
                        onChange={() => toggleTransactionSelection(transaction.id)}
                      />
                      <div>{transaction.date}</div>
                      <div>{transaction.description}</div>
                      <div>{transaction.account}</div>
                      <select
                        value={transaction.category}
                        onChange={(e) =>
                          updateTransactionCategory(transaction.id, e.target.value)
                        }
                      >
                        <option>Income</option>
                        {EXPENSE_CATEGORIES.map((category) => (
                          <option key={category}>{category}</option>
                        ))}
                      </select>
                      <div className={transaction.amount < 0 ? "money-out" : "money-in"}>
                        {formatMoney(transaction.amount)}
                      </div>
                      <div>
                        <span className="qb-status draft">{transaction.status}</span>
                        {transaction.categorizedBy === "AI" && (
                          <small className="ai-category-note">
                            Suggested by AI
                          </small>
                        )}
                        {transaction.learnedRuleId && (
                          <small className="ai-category-note">Remembered vendor</small>
                        )}
                      </div>
                      <button
                        disabled={transaction.status === "Matched"}
                        onClick={() => approveTransaction(transaction)}
                      >
                        Add
                      </button>
                    </div>
                  ))
                )}
              </div>

              {showConnectionsModal && (
                <div className="qb-modal">
                  <div className="connections-modal-box">
                    <div className="connections-modal-head">
                      <div>
                        <h2>Manage connections</h2>
                        <p>Add, edit, remove, or import bank and card activity.</p>
                      </div>
                      <button
                        className="modal-close-btn"
                        onClick={() => {
                          resetConnectionForm();
                          setShowConnectionsModal(false);
                        }}
                      >
                        Close
                      </button>
                    </div>

                    <div className="bank-connect-panel in-modal">
                      <div>
                        <h2>Secure transaction connection</h2>
                        <p>
                          Use Plaid Link for real bank, card, and supported Venmo connections.
                          Credentials stay inside Plaid or the financial institution flow.
                        </p>
                      </div>
                      <div className="bank-connect-actions">
                        <button
                          className="qb-new-btn"
                          disabled={isPlaidConnecting}
                          onClick={connectWithPlaid}
                        >
                          {isPlaidConnecting ? "Opening Plaid..." : "Connect with Plaid"}
                        </button>
                        <button
                          className="qb-new-btn secondary"
                          onClick={() => syncPlaidTransactions()}
                        >
                          Sync Plaid
                        </button>
                        <button
                          className="qb-new-btn secondary"
                          onClick={refreshPlaidTransactions}
                        >
                          Refresh Plaid now
                        </button>
                        <label className="csv-import-btn">
                          Import Venmo CSV
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            hidden
                            onChange={(e) => importBankCsv(e.target.files[0])}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="connection-manager in-modal">
                      <div>
                        <h2>{editingConnectionId ? "Edit connection" : "Add connection"}</h2>
                        <p>Track bank, debit, and credit card accounts that feed transactions.</p>
                      </div>
                      <div className="connection-form">
                        <select
                          value={connectionForm.type}
                          onChange={(e) => updateConnectionForm("type", e.target.value)}
                        >
                          <option>Bank</option>
                          <option>Debit Card</option>
                          <option>Credit Card</option>
                          <option>Cash App</option>
                          <option>Venmo</option>
                        </select>
                        <input
                          value={connectionForm.institution}
                          onChange={(e) => updateConnectionForm("institution", e.target.value)}
                          placeholder="Institution"
                        />
                        <input
                          value={connectionForm.name}
                          onChange={(e) => updateConnectionForm("name", e.target.value)}
                          placeholder="Account nickname"
                        />
                        <input
                          value={connectionForm.last4}
                          onChange={(e) => updateConnectionForm("last4", e.target.value.slice(0, 4))}
                          placeholder="Last 4"
                        />
                        <input
                          type="number"
                          value={connectionForm.balance}
                          onChange={(e) => updateConnectionForm("balance", e.target.value)}
                          placeholder="Balance"
                        />
                        <button onClick={saveConnection}>
                          {editingConnectionId ? "Save connection" : "Add connection"}
                        </button>
                        {editingConnectionId && (
                          <button className="quiet-action" onClick={resetConnectionForm}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="connections-list">
                      <h2>Current connections</h2>
                      {bankAccounts.length === 0 ? (
                        <div className="qb-empty">No connections yet.</div>
                      ) : (
                        bankAccounts.map((account) => (
                          <div className="connection-row" key={account.id}>
                            <div>
                              <strong>{account.name}</strong>
                              <span>
                                {account.type || "Bank"} · {account.institution}
                                {account.last4 ? ` · ${account.last4}` : ""}
                              </span>
                            </div>
                            <b>{formatMoney(account.balance)}</b>
                            <div className="connection-card-actions">
                              <button onClick={() => editConnection(account)}>Edit</button>
                              <button
                                className="text-danger"
                                onClick={() => removeConnection(account)}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {dashboardView === "reports" && (
            <div className="accounting-grid">
              <div className="accounting-panel">
                <h2>Profit and loss</h2>
                <div className="report-line">
                  <span>Total income</span>
                  <strong>{formatMoney(revenueTotal)}</strong>
                </div>
                <div className="report-line">
                  <span>Total expenses</span>
                  <strong>{formatMoney(expenseTotal)}</strong>
                </div>
                <div className="report-line total">
                  <span>Net income</span>
                  <strong>{formatMoney(revenueTotal - expenseTotal)}</strong>
                </div>
              </div>

              <div className="accounting-panel">
                <h2>Expenses by category</h2>
                {categoryTotals.length === 0 ? (
                  <p className="muted">No categorized expenses yet.</p>
                ) : (
                  categoryTotals.map((row) => (
                    <div className="category-row" key={row.category}>
                      <span>{row.category}</span>
                      <strong>{formatMoney(row.total)}</strong>
                    </div>
                  ))
                )}
              </div>

              <div className="accounting-panel wide">
                <h2>Expense report</h2>
                <div className="mini-report-head">
                  <span>Date</span>
                  <span>Payee</span>
                  <span>Category</span>
                  <span>Amount</span>
                </div>
                {expenses.slice(0, 8).map((expense) => (
                  <div className="mini-report-row" key={expense.id}>
                    <span>{expense.date}</span>
                    <span>{expense.payee}</span>
                    <span>{expense.category}</span>
                    <strong>{formatMoney(expense.amount)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          {dashboardView === "budgets" && (
            <div className="accounting-grid">
              {EXPENSE_CATEGORIES.slice(0, 8).map((category, index) => {
                const spent = expenses
                  .filter((expense) => expense.category === category)
                  .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
                const budget = [300, 500, 150, 1200, 800, 450, 350, 250][index];
                const width = Math.min((spent / budget) * 100, 100);

                return (
                  <div className="budget-card" key={category}>
                    <div>
                      <strong>{category}</strong>
                      <span>{formatMoney(spent)} of {formatMoney(budget)}</span>
                    </div>
                    <div className="budget-meter">
                      <span style={{ width: `${width}%` }}></span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {dashboardView === "accounts" && currentUser?.role === "admin" && (
            <div className="accounts-admin">
              <form className="account-create-card" onSubmit={createUser}>
                <h2>Create account</h2>
                <p>New accounts start with an empty, private workspace.</p>
                <label>
                  Username
                  <input
                    value={newUserForm.username}
                    onChange={(event) =>
                      setNewUserForm((current) => ({ ...current, username: event.target.value }))
                    }
                    minLength={3}
                    required
                  />
                </label>
                <label>
                  Temporary password
                  <input
                    type="password"
                    value={newUserForm.password}
                    onChange={(event) =>
                      setNewUserForm((current) => ({ ...current, password: event.target.value }))
                    }
                    minLength={12}
                    required
                  />
                </label>
                <button className="qb-new-btn" type="submit">Create account</button>
                {accountNotice && <div className="account-notice">{accountNotice}</div>}
              </form>
              <div className="account-list-card">
                <h2>Accounts</h2>
                {users.map((user) => (
                  <div className="account-row" key={user.id}>
                    <div>
                      <strong>{user.username}</strong>
                      <span>{user.role}{user.active ? " · Active" : " · Disabled"}</span>
                    </div>
                    <div className="account-row-actions">
                      <button type="button" onClick={() => resetUserPassword(user)}>Reset password</button>
                      <button
                        type="button"
                        disabled={String(user.id) === String(currentUser.id)}
                        onClick={() => setUserActive(user, !user.active)}
                      >
                        {user.active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
  
        {activeInvoice && (
          <div className="qb-modal invoice-action-modal" onClick={() => setActiveInvoice(null)}>
            <div
              className="invoice-action-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="invoice-action-title"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="invoice-action-close"
                type="button"
                aria-label="Close"
                onClick={() => setActiveInvoice(null)}
              >
                ×
              </button>

              <div className="invoice-action-icon" aria-hidden="true">⌑</div>
              <div className="invoice-action-heading">
                <span>{getDocumentLabel(activeInvoice.documentType, "short")}</span>
                <h2 id="invoice-action-title">{activeInvoice.invoiceNo}</h2>
                <p>{activeInvoice.clientName || "Untitled customer"}</p>
              </div>

              <div className="invoice-action-summary">
                <div>
                  <span>Type</span>
                  <select
                    className="invoice-action-type"
                    value={activeInvoice.documentType || "invoice"}
                    onChange={(event) =>
                      changeSavedDocumentType(activeInvoice, event.target.value)
                    }
                  >
                    <option value="invoice">Invoice</option>
                    <option value="quote">Quote</option>
                    <option value="expense">Expense</option>
                  </select>
                </div>
                <div>
                  <span>Total</span>
                  <strong>{activeInvoice.total}</strong>
                </div>
                <div>
                  <span>Date</span>
                  <strong>{activeInvoice.date || "—"}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong className={`invoice-action-status ${normalizeDocumentStatus(activeInvoice.documentType, activeInvoice.status)}`}>
                    {normalizeDocumentStatus(activeInvoice.documentType, activeInvoice.status)}
                  </strong>
                </div>
              </div>
  
              <div className="invoice-action-buttons">
                <button
                  className="invoice-action-primary"
                  onClick={() => {
                    loadInvoiceRecord(activeInvoice);
                    setScreen("invoice");
                    setActiveInvoice(activeInvoice);
                  }}
                >
                  Open & Edit
                </button>
  
                <button
                  onClick={() => {
                    const duplicateNumber = `${activeInvoice.invoiceNo}-COPY`;
                    const copy = {
                      ...activeInvoice,
                      id: Date.now(),
                      invoiceNo: duplicateNumber,
                      status: "draft",
                      title: `${getDocumentLabel(activeInvoice.documentType, "short")} ${duplicateNumber}`,
                      data: {
                        ...activeInvoice.data,
                        invoiceNo: duplicateNumber,
                        items: activeInvoice.data?.items?.map((item) => ({ ...item })) || [],
                      },
                    };
  
                    const updated = [copy, ...invoices];
                    setInvoices(updated);
                    setActiveInvoice(copy);
                  }}
                >
                  Duplicate
                </button>
              </div>

              <div className="invoice-action-footer">
                <button
                  className="invoice-action-delete"
                  onClick={() => {
                    const updated = invoices.filter(
                      (i) => i.id !== activeInvoice.id
                    );
                    setInvoices(updated);
                    setActiveInvoice(null);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {showPasswordModal && (
          <div className="qb-modal password-modal" onClick={() => setShowPasswordModal(false)}>
            <form
              className="password-card"
              aria-labelledby="change-password-title"
              onClick={(event) => event.stopPropagation()}
              onSubmit={changeMyPassword}
            >
              <button
                className="invoice-action-close"
                type="button"
                aria-label="Close"
                onClick={() => setShowPasswordModal(false)}
              >
                ×
              </button>
              <h2 id="change-password-title">Change password</h2>
              <p>Choose a unique password with at least 12 characters.</p>
              <input
                className="password-username"
                name="username"
                value={currentUser?.username || ""}
                autoComplete="username"
                readOnly
                tabIndex={-1}
                aria-hidden="true"
              />
              <label>
                Current password
                <input
                  name="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={passwordForm.currentPassword}
                  onChange={(event) =>
                    setPasswordForm((current) => ({
                      ...current,
                      currentPassword: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              <label>
                New password
                <input
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={passwordForm.newPassword}
                  onChange={(event) =>
                    setPasswordForm((current) => ({
                      ...current,
                      newPassword: event.target.value,
                    }))
                  }
                  required
                />
              </label>
              {passwordNotice && <div className="password-notice">{passwordNotice}</div>}
              <button className="qb-new-btn" type="submit" disabled={isChangingPassword}>
                {isChangingPassword ? "Saving…" : "Save new password"}
              </button>
            </form>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="invoice-editor">
      <header className="invoice-toolbar no-pdf">
        <div className="invoice-toolbar-side invoice-toolbar-left">
          <button
            className="toolbar-close"
            type="button"
            aria-label="Close invoice"
            title="Close"
            onClick={() => {
              if (!hasUnsavedInvoiceChanges()) {
                setScreen("dashboard");
                return;
              }

              const leave = window.confirm("Leave without saving changes?");
              if (leave) setScreen("dashboard");
            }}
          >
            ×
          </button>
          <button
            className="toolbar-save-close"
            type="button"
            onClick={() => {
              saveInvoiceRecord();
              setScreen("dashboard");
            }}
          >
            Save & Close
          </button>
          <div className="toolbar-document-name">
            <strong>{getDocumentLabel(documentType, "short")} {invoiceNo}</strong>
            <span>{clientName || "New document"}</span>
          </div>
        </div>

        <div className="invoice-toolbar-actions">
          <details className="toolbar-more" ref={toolbarMoreRef}>
            <summary aria-label="More actions" title="More actions">•••</summary>
            <div className="toolbar-more-menu">
              <button
                type="button"
                onClick={() => {
                  setDocumentType("quote");
                  saveInvoiceRecord("draft", "quote");
                  setScreen("dashboard");
                }}
              >
                Save as Quote
              </button>
              <button type="button" className="toolbar-danger" onClick={resetInvoice}>
                Reset document
              </button>
            </div>
          </details>
          <button className="toolbar-button" type="button" onClick={openPdfPreview}>
            Export PDF
          </button>
          <button
            className="toolbar-button"
            type="button"
            onClick={() => saveInvoiceRecord()}
          >
            Save
          </button>
          <button
            className="toolbar-button toolbar-primary"
            type="button"
            onClick={async () => {
              try {
                setEmailTo(clientEmail);
                setEmailSubject(
                  `${getDocumentLabel(documentType, "short")} ${invoiceNo} from WILLAMIKO .LLC`
                );
                setShowEmailPreview(true);

                const pdfBlob = await generatePdfBlob();
                const localUrl = URL.createObjectURL(pdfBlob);
                setPdfPreviewUrl(localUrl);
                const hostedUrl = await createHostedPdfLink(pdfBlob);
                setHostedPdfUrl(hostedUrl);

                setInvoiceStatus("sent");
                saveInvoiceRecord("sent");
              } catch (err) {
                console.error(err);
                alert("Send failed");
              }
            }}
          >
            Send
          </button>
        </div>
      </header>

      <div className="invoice-sheet" ref={invoiceRef}>
        <div className="invoice-header">
          <div className="left-header">
            <h1>{getDocumentLabel(documentType, "upper")}</h1>

            <div className="company-block">
              <strong>WILLAMIKO .LLC</strong>
              <span>24256 Huber Ave</span>
              <span>Torrance, CA 90501</span>
              <span>wakayamafilms@gmail.com</span>
              <span>+1 (310) 998-7795</span>
            </div>
          </div>

          <div className="logo-upload">
            <input
              id="logoUpload"
              type="file"
              accept="image/*"
              hidden
              
              onChange={(e) => {
                const file = e.target.files[0];
                if (!file) return;
              
                setLogo(URL.createObjectURL(file));
              
                const reader = new FileReader();
              
                reader.onloadend = () => {
                  setEmailLogo(reader.result);
                };
              
                reader.readAsDataURL(file);
              }}

            />

<label htmlFor="logoUpload" className="logo-box">
  <img src={logo} alt="logo" style={{ width: `${logoSize}px` }} />
</label>

            {logo && (
              <input
                type="range"
                min="40"
                max="155"
                value={logoSize}
                onChange={(e) => setLogoSize(e.target.value)}
                className="logo-slider"
              />
            )}
          </div>
        </div>

        <div className="info-band">
          <div className="info-inner">
          <div className="bill-to">
  <div className="bill-to-label">Bill to</div>

  <div className="bill-to-fields">
  <input
    value={clientName}
    list="saved-customer-suggestions"
    onChange={(e) => {
      const nextName = e.target.value;
      setClientName(nextName);
      const match = customerRows.find(
        (customer) => customer.name.toLowerCase() === nextName.toLowerCase()
      );
      if (match) selectInvoiceCustomer(match);
    }}
    placeholder="Client Name"
    className="bill-line"
  />
  <datalist id="saved-customer-suggestions">
    {customerRows.map((customer) => (
      <option value={customer.name} key={customer.id}>
        {customer.company || customer.email || "Saved contact"}
      </option>
    ))}
  </datalist>

  {customerRows.length > 0 && (
    <select
      className="customer-picker no-pdf"
      value=""
      aria-label="Choose a saved customer"
      onChange={(e) => {
        const selected = customerRows.find(
          (customer) => String(customer.id) === e.target.value
        );
        selectInvoiceCustomer(selected);
      }}
    >
      <option value="">Choose from address book…</option>
      {customerRows.map((customer) => (
        <option value={customer.id} key={customer.id}>{customer.name}</option>
      ))}
    </select>
  )}

  <input
    value={clientEmail}
    onChange={(e) => setClientEmail(e.target.value)}
    placeholder="Email"
    className="bill-line"
  />

  <input
    value={address1}
    onChange={(e) => setAddress1(e.target.value)}
    placeholder="Address line 1"
    className="bill-line"
  />

  <input
    value={address2}
    onChange={(e) => setAddress2(e.target.value)}
    placeholder="Address line 2, City, State ZIP"
    className="bill-line"
  />
</div>
</div>

            <div className="divider-line"></div>

            <div className="details-block">
              <h4>{getDocumentLabel(documentType, "details")}</h4>

              <div className="detail-edit-row">
                <span>{getDocumentLabel(documentType, "number")}</span>
                <input
                  className="invoice-number-input"
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                />
              </div>

              <div className="detail-edit-row">
                <span>Terms:</span>
                <select value={terms} onChange={(e) => setTerms(e.target.value)}>
                  <option>Due on receipt</option>
                  <option>Net 7</option>
                  <option>Net 30</option>
                  <option>Net 60</option>
                </select>
              </div>

              <div className="detail-edit-row">
                <span>{getDocumentLabel(documentType, "date")}</span>
                <input
                  className="invoice-detail-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                />
              </div>

              <div className="detail-edit-row">
                <span>Due date:</span>
                <input
                  className="invoice-detail-date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>

            </div>
          </div>
        </div>

        <div className="invoice-table">
          <div className="table-row table-head">
            <span>#</span>
            <span>Date</span>
            <span>Product or service</span>
            <span>Description</span>
            <span>Qty</span>
            <span>Rate</span>
            <span>Amount</span>
            <span></span>
          </div>

          {items.map((item, i) => (
            <div className="table-row" key={i}>
              <span>{i + 1}.</span>

              <input
                type="date"
                value={item.date}
                onChange={(e) => updateItem(i, "date", e.target.value)}
              />

              <input
                className="product-input"
                value={item.product}
                onChange={(e) => updateItem(i, "product", e.target.value)}
              />

              <input
                value={item.description}
                onChange={(e) => updateItem(i, "description", e.target.value)}
              />

              <input
                type="number"
                value={item.qty}
                onChange={(e) => updateItem(i, "qty", e.target.value)}
              />

              <input
                type="number"
                value={item.rate}
                onChange={(e) => updateItem(i, "rate", e.target.value)}
              />

              <strong>
                {formatMoney(Number(item.qty || 0) * Number(item.rate || 0))}
              </strong>

              <button className="remove-btn" onClick={() => removeLine(i)}>
                ×
              </button>
            </div>
          ))}
        </div>

        <button className="add-line-btn" onClick={addLine}>
          + Add line
        </button>

        <div className="bottom-section">
          
        <div className="notes-box">
  <textarea
    placeholder="Notes (ACH info, payment instructions, etc.)"
    value={notes}
    onChange={(e) => setNotes(e.target.value)}
  />
</div>


          <div className="totals">
            <div>
              <span>Total</span>
              <strong>{formatMoney(total)}</strong>
            </div>
          </div>
        </div>

      </div>

      {/* PDF MODAL */}
      {showPdfPreview && (
        <div className="pdf-modal no-pdf">
          <div className="pdf-modal-content">
            <div className="pdf-modal-header">
              <strong>PDF Preview</strong>

              <div>
                <button onClick={downloadPdfFromPreview}>Download</button>
                <button
                  className="cancel-btn"
                  onClick={() => setShowPdfPreview(false)}
                >
                  Cancel
                </button>
              </div>
            </div>

            <div className="pdf-preview-frame">
              <div className="pdf-preview-note">
                This preview will download as a letter-size PDF.
              </div>

              <div className="pdf-preview-page">
                {invoiceRef.current && (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: invoiceRef.current.outerHTML,
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* EMAIL MODAL */}
{showEmailPreview && (
  <div className="email-modal">
    <div className="email-modal-content">
    {isSendingEmail && (
  <div className="sending-overlay">
    <div className="sending-box">
      <div className="sending-spinner"></div>
      <strong>Sending {getDocumentLabel(documentType, "lower")}...</strong>
      <span>Please wait while your email is being sent.</span>
    </div>
  </div>

)}

      <div className="email-modal-header">

      

        <strong>Email Preview</strong>

        <div>
        <button onClick={sendEmail} disabled={isSendingEmail}>
          {isSendingEmail ? "Sending..." : "Send"}
        </button>
          <button
            className="cancel-btn"
            onClick={() => setShowEmailPreview(false)}
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="email-header-fields">
        <label>
          To:
          <input
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="recipient@email.com"
          />
        </label>

        <label>
          Cc:
          <input
            value={emailCc}
            onChange={(e) => setEmailCc(e.target.value)}
            placeholder="optional"
          />
        </label>

        <label>
          From:
          <input
            value={emailFrom}
            onChange={(e) => setEmailFrom(e.target.value)}
          />
        </label>

        <label>
          Subject:
          <input
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
          />
        </label>

        <label>
          Attachments:
          <input
            type="file"
            multiple
            onChange={(e) =>
              setExtraAttachments(Array.from(e.target.files))
            }
          />
        </label>
      </div>

      <div className="email-preview-wrap">
        <div className="email-preview">
          {logo && (
            <div className="email-logo">
              <img src={logo} alt="logo" />
            </div>
          )}

          <div className="email-blue-band">
            <h2>Your {getDocumentLabel(documentType, "lower")} is ready!</h2>
            <p>Total {formatMoney(total)}</p>

            <div className="balance-label">
              {getDocumentLabel(documentType, "totalLabel")}
            </div>
            <div className="balance-amount">{formatMoney(total)}</div>
          </div>

          <div className="email-body">
            <p>Dear {clientName || "Customer"},</p>

            <p>
              We appreciate your business. Please find your{" "}
              {getDocumentLabel(documentType, "lower")} details here.
            </p>

            <button className="view-details-btn" onClick={openInvoicePdf}>
  View Details
</button>

{notes && (
  <div className="invoice-notes-text">
    {notes.split("\n").map((line, index) => (
      <div key={index}>{line}</div>
    ))}
  </div>
)}

            <p>
  Have a great day!
  <br />
  Willamiko
</p>

<div className="email-contact-block">
  <div className="email-company-name">WILLAMIKO .LLC</div>

  <div className="email-address">
    24256 Huber Ave<br />
    Torrance, CA 90501
  </div>

  <div className="email-contact-links">
    wakayamafilms@gmail.com<br />
    +1 (310) 998-7795
  </div>

  <div className="gmail-attachments">
  {pdfPreviewUrl && (
    <div className="gmail-attachment-card">
      <div
  className="gmail-thumb pdf-thumb"
  onClick={openInvoicePdf}
>
        {pdfThumbnail ? (
  <img
    className="real-pdf-thumb-img"
    src={pdfThumbnail}
    alt="Invoice PDF preview"
  />
) : (
  <div className="pdf-mini-page">
    <div className="pdf-mini-title">
      {getDocumentLabel(documentType, "upper")}
    </div>
    <div className="pdf-mini-line short"></div>
    <div className="pdf-mini-line"></div>
    <div className="pdf-mini-band"></div>
    <div className="pdf-mini-line"></div>
    <div className="pdf-mini-line"></div>
  </div>
)}

<span className="pdf-badge">PDF</span>
      </div>

      <div className="gmail-attachment-footer">
  <div className="attachment-name">
    {getDocumentLabel(documentType, "short")}_{invoiceNo}_from_WILLAMIKO_LLC.pdf
  </div>

  <button
    className="attachment-remove"
    onClick={() => setPdfPreviewUrl(null)}
  >
    ×
  </button>
</div>
    </div>
  )}

  {extraAttachments.map((file, index) => (
    <div className="gmail-attachment-card" key={index}>
      <div className="gmail-thumb pdf-thumb" onClick={openInvoicePdf}>
      </div>
    </div>
  ))}


</div>

</div>



          </div>
        </div>
      </div>
    </div>
  </div>

  
)}

{showSentConfirmation && (
  <div className="sent-modal">
    <div className="sent-modal-box">
      <h2>Email sent</h2>
      <p>Your {getDocumentLabel(documentType, "lower")} email was sent successfully.</p>

      <button
        onClick={() => {
          setShowSentConfirmation(false);
          setStatus("");
        }}
      >
        Close
      </button>
    </div>
  </div>
)}

    </div>
  );
}

export default App;
