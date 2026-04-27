const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;


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
      url: `http://localhost:3001/invoices/${filename}`,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});