import { useRef, useState } from "react";
import html2pdf from "html2pdf.js";
import "./App.css";
import html2canvas from "html2canvas";

function App() {
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("1018");
  const [terms, setTerms] = useState("Due on receipt");
  const [invoiceDate, setInvoiceDate] = useState("2026-01-27");
  const [dueDate, setDueDate] = useState("2026-01-27");
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
  const invoiceRef = useRef(null);
  

  function resetInvoice() {
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
    
  }

  function getInvoiceData() {
    return {
      clientName,
      clientEmail,
      address1,
      address2,
      invoiceNo,
      terms,
      invoiceDate,
      dueDate,
      notes,
      items,
      logo,
      logoSize,
    };
  }
  
  function saveDraft() {
    try {
      alert("Save Draft clicked.");
  
      const draftName = `Invoice ${invoiceNo || "No Number"} - ${
        clientName || "Untitled"
      }`;
  
      const existingDrafts =
        JSON.parse(localStorage.getItem("willamiko_drafts")) || [];
  
      const newDraft = {
        id: Date.now(),
        name: draftName,
        createdAt: new Date().toLocaleString(),
        data: getInvoiceData(),
      };
  
      const updatedDrafts = [newDraft, ...existingDrafts];
  
      localStorage.setItem("willamiko_drafts", JSON.stringify(updatedDrafts));
  
      alert(`Draft saved:\n${draftName}`);
    } catch (err) {
      console.error("Save draft failed:", err);
      alert("Draft failed to save. Check console.");
    }
  }
  
  function loadDraft(draft) {
    const data = draft.data;
  
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
      const drafts = JSON.parse(localStorage.getItem("willamiko_drafts")) || [];
  
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

  const total = items.reduce(
    (sum, item) => sum + Number(item.qty || 0) * Number(item.rate || 0),
    0
  );

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
          <title>Invoice_${invoiceNo}.pdf</title>
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
    const copy = [...items];
    copy[index][field] = value;
    setItems(copy);
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
    link.download = `Invoice_${invoiceNo}.pdf`;
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
            .querySelectorAll(".add-line-btn, .remove-btn, .actions, .status, .logo-slider")
            .forEach((el) => (el.style.display = "none"));
  
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
      `Invoice_${invoiceNo}_from_WILLAMIKO_LLC.pdf`
    );
    
    if (emailLogo) {
      formData.append("logo", emailLogo);
    }
    
    if (emailLogo) {
      formData.append("logo", emailLogo);
    }
    
    if (logo) {
      formData.append("logo", logo);
    }
  
    if (logo) {
      formData.append("logo", logo);
    }

    const res = await fetch("http://localhost:3001/host-invoice-pdf", {
      method: "POST",
      body: formData,
    });
  
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
          .querySelectorAll(".add-line-btn, .remove-btn, .actions, .status, .logo-slider")
          .forEach((el) => {
            el.style.display = "none";
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
        emailSubject || `Invoice ${invoiceNo} from WILLAMIKO .LLC`
      );
      formData.append("clientName", clientName);
      formData.append("total", formatMoney(total));
      formData.append("notes", notes);
      formData.append("hostedPdfUrl", finalHostedPdfUrl);
      formData.append(
        "invoicePdf",
        pdfBlob,
        `Invoice_${invoiceNo}_from_WILLAMIKO_LLC.pdf`
      );
  
      extraAttachments.forEach((file) => {
        formData.append("attachments", file);
      });
  
      const res = await fetch("http://localhost:3001/send-email", {
        method: "POST",
        body: formData,
      });
  
      if (!res.ok) {
        const errorText = await res.text();
        console.error("Email failed:", errorText);
        alert("Email failed. Check your server terminal.");
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
      alert("Email failed. Check console + server.");
      setStatus("");
      setIsSendingEmail(false);
    }
  }



  return (
    <div className="page">
      <div className="invoice-sheet" ref={invoiceRef}>
        <div className="invoice-header">
          <div className="left-header">
            <h1>INVOICE</h1>

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
    onChange={(e) => setClientName(e.target.value)}
    placeholder="Client Name"
    className="bill-line"
  />

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
              <h4>Invoice details</h4>

              <div className="detail-edit-row">
                <span>Invoice no.:</span>
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
                <span>Invoice date:</span>
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

        <div className="actions">

        <button type="button" onClick={saveDraft}>
  Save Draft
</button>

<button type="button" onClick={openDrafts}>
  Load Draft
</button>


  <button className="reset-btn" onClick={resetInvoice}>
    Reset
  </button>

  <button onClick={openPdfPreview}>Download PDF</button>
          
          <button
  onClick={async () => {
    setEmailTo(clientEmail);
    setEmailSubject(`Invoice ${invoiceNo} from WILLAMIKO .LLC`);

    setShowEmailPreview(true);

    const pdfBlob = await generatePdfBlob();

    const localUrl = URL.createObjectURL(pdfBlob);
    setPdfPreviewUrl(localUrl);

    const hostedUrl = await createHostedPdfLink(pdfBlob);
    setHostedPdfUrl(hostedUrl);

    try {
      const thumb = await generateInvoiceThumbnail();
      setPdfThumbnail(thumb);
    } catch (err) {
      console.error("Thumbnail failed:", err);
    }
  }}
>
  Send
</button>

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
      <strong>Sending invoice...</strong>
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
            <h2>Your invoice is ready!</h2>
            <p>Total {formatMoney(total)}</p>

            <div className="balance-label">BALANCE DUE</div>
            <div className="balance-amount">{formatMoney(total)}</div>
          </div>

          <div className="email-body">
            <p>Dear {clientName || "Customer"},</p>

            <p>
              We appreciate your business. Please find your invoice details here.
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
    <div className="pdf-mini-title">INVOICE</div>
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
    Invoice_{invoiceNo}_from_WILLAMIKO_LLC.pdf
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
      <p>Your invoice email was sent successfully.</p>

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