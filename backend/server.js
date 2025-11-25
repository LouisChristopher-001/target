require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const DEBUG_SALES = true;

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "https://target-fawn.vercel.app"   // your Vercel frontend
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow mobile / Postman / curl with no origin
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);


app.use(express.json());

// ---------- MongoDB connection ----------
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/sales_target_db";

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

// ---------- Schemas and Models ----------

const salespersonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    brand: { type: String, default: null },
    section: { type: String, default: null }   // 👈 NEW
  },
  { timestamps: true }
);


const monthlyTargetSchema = new mongoose.Schema(
  {
    salesperson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesperson",
      required: true
    },
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    target: { type: Number, default: 0 }
  },
  { timestamps: true }
);
monthlyTargetSchema.index(
  { salesperson: 1, year: 1, month: 1 },
  { unique: true }
);

const monthlyAchievementSchema = new mongoose.Schema(
  {
    salesperson: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesperson",
      required: true
    },
    year: { type: Number, required: true },
    month: { type: Number, required: true },
    ownAchievement: { type: Number, default: 0 },
    otherAchievement: { type: Number, default: 0 },
    totalAchievement: { type: Number, default: 0 }
  },
  { timestamps: true }
);
monthlyAchievementSchema.index(
  { salesperson: 1, year: 1, month: 1 },
  { unique: true }
);

const Salesperson = mongoose.model("Salesperson", salespersonSchema);
const MonthlyTarget = mongoose.model("MonthlyTarget", monthlyTargetSchema);
const MonthlyAchievement = mongoose.model(
  "MonthlyAchievement",
  monthlyAchievementSchema
);

// ---------- Multer ----------
const upload = multer({
  dest: "uploads/"
});

// ---------- Business helpers ----------

const FINANCE_CUSTOMERS = new Set([
  "BAJAJ FINANCE LTD",
  "TVS FINANCE LTD",
  "HDB FINANCE LTD"
]);

function num(val) {
  if (val === undefined || val === null || val === "") return 0;
  const n = Number(String(val).replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

function isSparesItem(itemModel) {
  if (!itemModel) return false;
  return String(itemModel).trim().toUpperCase().startsWith("SPARES");
}

// Normalise invoice number (for matching sales and return files)
function normalizeInvoiceNo(v) {
  if (!v) return "";
  return String(v)
    .trim()
    .toUpperCase()
    .replace(/\*+$/, ""); // remove trailing * characters
}

// Upsert salesperson without accidentally clearing brand
async function upsertSalesperson(name, brand) {
  const normalizedName = name.trim().toUpperCase();
  const existing = await Salesperson.findOne({ name: normalizedName });

  if (existing) {
    // Only touch brand if brand parameter is actually passed
    if (typeof brand !== "undefined") {
      existing.brand = brand ? brand.trim().toUpperCase() : null;
      await existing.save();
    }
    return existing;
  }

  const sp = new Salesperson({
    name: normalizedName,
    brand:
      typeof brand === "undefined"
        ? null
        : brand
        ? brand.trim().toUpperCase()
        : null
  });
  await sp.save();
  return sp;
}

// Upsert achievement: treat inputs as deltas and ADD them
// We clear the whole month once before processing current sales+returns.
async function upsertSalesperson(name, brand, section) {
  const normalizedName = name.trim().toUpperCase();
  const existing = await Salesperson.findOne({ name: normalizedName });

  if (existing) {
    // Only update if values are actually passed in
    if (typeof brand !== "undefined") {
      existing.brand = brand ? brand.trim().toUpperCase() : null;
    }
    if (typeof section !== "undefined") {
      existing.section = section ? section.trim().toUpperCase() : null;
    }
    await existing.save();
    return existing;
  }

  const sp = new Salesperson({
    name: normalizedName,
    brand:
      typeof brand === "undefined"
        ? null
        : brand
        ? brand.trim().toUpperCase()
        : null,
    section:
      typeof section === "undefined"
        ? null
        : section
        ? section.trim().toUpperCase()
        : null
  });

  await sp.save();
  return sp;
}


// ---------- RETURN FILE PARSER (only "Ref. Doc. Info." column) ----------

/**
 * Return file format:
 *  - Single important column named "Ref. Doc. Info." (may have spaces)
 *  - Each cell value looks like "GI/16909*  02-11-2025" or similar
 *  - We only need the bill number at the front
 */
function extractReturnInvoiceSet(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const returnSet = new Set();

  if (!rows.length) {
    if (DEBUG_SALES) console.log("⚠️ Return file has no rows");
    return returnSet;
  }

  const headerRow = rows[0];
  let refColIndex = headerRow.findIndex((c) =>
    String(c).trim().toUpperCase().startsWith("REF. DOC")
  );

  if (refColIndex === -1) {
    // Fallback: just assume first column
    refColIndex = 0;
  }

  if (DEBUG_SALES) {
    console.log("📄 Return file using column index:", refColIndex);
    console.log("   Header row:", headerRow);
  }

  for (let i = 1; i < rows.length; i++) {
    const rowArr = rows[i];
    const cell = rowArr[refColIndex];
    const raw = String(cell || "").trim();
    if (!raw) continue;

    // Take first token as bill no (before first space)
    const firstToken = raw.split(/\s+/)[0];
    const norm = normalizeInvoiceNo(firstToken);
    if (norm) {
      returnSet.add(norm);
    }
  }

  if (DEBUG_SALES) {
    console.log(
      "✅ Extracted return invoice count:",
      returnSet.size,
      "| sample:",
      Array.from(returnSet).slice(0, 10)
    );
  }

  return returnSet;
}

// Upsert achievement: treat inputs as deltas and ADD them
// We clear the whole month once before processing current sales+returns.
async function upsertAchievement(
  salespersonId,
  year,
  month,
  ownDelta,
  otherDelta
) {
  const existing = await MonthlyAchievement.findOne({
    salesperson: salespersonId,
    year,
    month
  });

  const totalDelta = ownDelta + otherDelta;

  if (existing) {
    existing.ownAchievement += ownDelta;
    existing.otherAchievement += otherDelta;
    existing.totalAchievement += totalDelta;
    await existing.save();
  } else {
    const doc = new MonthlyAchievement({
      salesperson: salespersonId,
      year,
      month,
      ownAchievement: ownDelta,
      otherAchievement: otherDelta,
      totalAchievement: totalDelta
    });
    await doc.save();
  }
}


// ---------- CORE LOGIC: processRowsForSalesperson ----------

/**
 * For each salesperson block:
 * - Credit bill rule still uses Net Invoice vs Amount Realised.
 * - SPARES: Net Amount of spare lines is deducted from invoice value.
 * - OWN vs OTHERS:
 *     * If salesperson has brand B:
 *         - If Item/Model starts with B => that row's Net Amount is OWN.
 *         - Else (non spare) => that row's Net Amount is OTHER.
 *     * If no brand => all non spare Net Amount is OTHER.
 * - Achievements are the sum of Net Amount of accepted lines (no proportional scaling).
 *
 * factor = 1 for normal sales (add), factor = -1 if we ever want to subtract.
 * returnInvoiceSet: Set of NORMALISED invoice numbers that must be skipped
 *   (sales return list).
 */
async function processRowsForSalesperson(
  rows,
  salespersonName,
  year,
  month,
  factor = 1,
  returnInvoiceSet = new Set()
) {
  if (DEBUG_SALES) {
    console.log(
      "\n🔍 Processing salesperson block:",
      salespersonName,
      "rows:",
      rows.length,
      "year:",
      year,
      "month:",
      month,
      "factor:",
      factor
    );
  }

  const invoices = new Map();
  let lastInvNo = null;

  for (const row of rows) {
    let invNoRaw =
      row["Invoice No."] ||
      row["Invoice No"] ||
      row["INVOICE NO"] ||
      row["Invoice"] ||
      row["Inv No"];

    invNoRaw = invNoRaw ? String(invNoRaw).trim() : "";

    // If this row does not repeat invoice number, inherit from previous line
    const normInvNo = invNoRaw ? normalizeInvoiceNo(invNoRaw) : lastInvNo;

    if (!normInvNo) {
      // No invoice number yet (and nothing to inherit) — skip
      continue;
    }

    // Update last non empty invoice number
    if (invNoRaw) {
      lastInvNo = normInvNo;
    }

    let inv = invoices.get(normInvNo);
    if (!inv) {
      inv = {
        invoiceNo: normInvNo,
        customer:
          row["Customer"] ||
          row["Financier/Customer"] ||
          row["Financier / Customer"] ||
          row["Party"] ||
          "",
        netInvoice: num(row["Net Invoice"] || row["Net Inv"]),
        amountRealised: num(row["Amount Realised"] || row["Amt Realised"]),
        invoiceValue: num(row["Invoice Value"] || row["Inv Value"]),
        ccCharges: num(row["(+) CREDIT CARD CHARGES"]),
        negRoundOff: num(row["(-) Round Off"]),
        posRoundOff: num(row["(+) Round Off"]),
        cashDiscount: num(row["(-) CASH DISCOUNT"]),
        items: []
      };
      invoices.set(normInvNo, inv);
    } else {
      // Fill in invoice level numbers only if still missing
      const invValueCandidate = num(row["Invoice Value"] || row["Inv Value"]);
      if (!inv.invoiceValue && invValueCandidate) {
        inv.invoiceValue = invValueCandidate;
      }

      const ccCandidate = num(row["(+) CREDIT CARD CHARGES"]);
      if (!inv.ccCharges && ccCandidate) {
        inv.ccCharges = ccCandidate;
      }

      const negCandidate = num(row["(-) Round Off"]);
      if (!inv.negRoundOff && negCandidate) {
        inv.negRoundOff = negCandidate;
      }

      const posCandidate = num(row["(+) Round Off"]);
      if (!inv.posRoundOff && posCandidate) {
        inv.posRoundOff = posCandidate;
      }

      const cashCandidate = num(row["(-) CASH DISCOUNT"]);
      if (!inv.cashDiscount && cashCandidate) {
        inv.cashDiscount = cashCandidate;
      }

      const netInvCandidate = num(row["Net Invoice"] || row["Net Inv"]);
      if (!inv.netInvoice && netInvCandidate) {
        inv.netInvoice = netInvCandidate;
      }

      const amtRealCandidate = num(
        row["Amount Realised"] || row["Amt Realised"]
      );
      if (!inv.amountRealised && amtRealCandidate) {
        inv.amountRealised = amtRealCandidate;
      }
    }

    // Add this line item (every row belonging to that invoice)
    inv.items.push({
      model: row["Item/Model"] || row["Item"] || "",
      brand: row["Brand"] || "",
      netAmount: num(row["Net Amount"] || row["Net Amt"])
    });
  }

  const salesperson = await Salesperson.findOne({
    name: salespersonName.trim().toUpperCase()
  });

  if (!salesperson) {
    console.error("❌ Salesperson not found in DB:", salespersonName);
    if (DEBUG_SALES) {
      console.log("   ⚠️ Skipping entire block for unknown salesperson");
    }
    return; // Do not throw, just ignore this block
  }

  const ownBrand = salesperson.brand
    ? salesperson.brand.toUpperCase()
    : null;

  if (DEBUG_SALES) {
    console.log(
      "👤 DB salesperson:",
      salesperson.name,
      "| brand:",
      ownBrand || "(no brand)"
    );
  }

  let totalOwn = 0;
  let totalOther = 0;

  for (const [invKey, inv] of invoices) {
    // Skip invoices present in return list
    if (returnInvoiceSet.has(invKey)) {
      if (DEBUG_SALES) {
        console.log(
          "   ⛔ Skipping invoice due to SALES RETURN list:",
          invKey
        );
      }
      continue;
    }

    const customer = String(inv.customer || "").trim().toUpperCase();

    // Final invoice value formula
    const finalInvoiceValue =
      inv.invoiceValue -
      inv.ccCharges -
      inv.negRoundOff +
      inv.posRoundOff -
      inv.cashDiscount;

    let sparesTotal = 0;
    let ownNet = 0;
    let otherNet = 0;

    for (const item of inv.items) {
      const model = String(item.model || "");
      const netAmount = item.netAmount || 0;
      if (!netAmount) continue;

      if (isSparesItem(model)) {
        sparesTotal += netAmount;
        if (DEBUG_SALES) {
          console.log(
            "   🔧 SPARES line:",
            inv.invoiceNo,
            "| model:",
            model,
            "| netAmount:",
            netAmount
          );
        }
        continue;
      }

      const modelUpper = model.toUpperCase();

      if (ownBrand && modelUpper.startsWith(ownBrand)) {
        ownNet += netAmount;
        if (DEBUG_SALES) {
          console.log(
            "   ✅ OWN line:",
            inv.invoiceNo,
            "| model:",
            model,
            "| netAmount:",
            netAmount
          );
        }
      } else {
        otherNet += netAmount;
        if (DEBUG_SALES) {
          console.log(
            "   📦 OTHER line:",
            inv.invoiceNo,
            "| model:",
            model,
            "| netAmount:",
            netAmount
          );
        }
      }
    }

    const adjustedInvoice = finalInvoiceValue - sparesTotal;

    const isMismatch =
      Math.round(inv.netInvoice || 0) !== Math.round(inv.amountRealised || 0);
    const isFinanceCustomer = FINANCE_CUSTOMERS.has(customer);

    if (DEBUG_SALES) {
      console.log(
        "🧾 Invoice:",
        inv.invoiceNo,
        "| customer:",
        customer,
        "| finalInvoiceValue:",
        finalInvoiceValue,
        "| sparesTotal:",
        sparesTotal,
        "| adjustedInvoice:",
        adjustedInvoice
      );
      console.log(
        "   Net totals for this invoice | OWN:",
        ownNet,
        "| OTHER:",
        otherNet,
        "| mismatch:",
        isMismatch,
        "| finance customer:",
        isFinanceCustomer
      );
    }

    if (isMismatch && !isFinanceCustomer) {
      if (DEBUG_SALES) {
        console.log("   ⛔ Skipping invoice due to credit mismatch");
      }
      continue;
    }

    if (ownNet === 0 && otherNet === 0) {
      if (DEBUG_SALES) {
        console.log("   ⚠️ No non-spare lines with value, skipping invoice");
      }
      continue;
    }

    totalOwn += ownNet;
    totalOther += otherNet;
  }

  if (DEBUG_SALES) {
    console.log(
      "✅ Totals for",
      salespersonName,
      "| OWN:",
      totalOwn,
      "| OTHER:",
      totalOther,
      "| factor:",
      factor
    );
  }

  const finalOwn = factor * totalOwn;
  const finalOther = factor * totalOther;

  await upsertAchievement(
    salesperson._id,
    year,
    month,
    finalOwn,
    finalOther
  );
}

// ---------- Multi-salesperson Excel (SALES) ----------

async function processExcelFileMulti(
  filePath,
  year,
  month,
  returnInvoiceSet = new Set()
) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Raw rows as arrays
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  let currentSalesperson = null;
  const rowsBySalesperson = {};
  let globalHeader = null;

  for (const rowArr of rows) {
    const firstCell = String(rowArr[0] || "").trim();
    const secondCell = String(rowArr[1] || "").trim();

    // Skip any row where the 2nd cell contains "total" (salesperson total line)
    if (secondCell.toUpperCase().includes("TOTAL")) {
      if (DEBUG_SALES) {
        console.log(
          "   🚫 Skipping row because 2nd cell contains 'TOTAL':",
          rowArr
        );
      }
      continue;
    }

    // 1) Detect the global header row ONCE: the row whose first cell is "Date"
    if (!globalHeader && /^Date$/i.test(firstCell)) {
      globalHeader = rowArr;
      if (DEBUG_SALES) {
        console.log("📋 Global header detected:", globalHeader);
      }
      continue;
    }

    // 2) Detect "Salesperson : NAME" lines
    if (/^Salesperson\s*:/i.test(firstCell)) {
      const parts = firstCell.split(":");
      const namePart = parts[1] ? parts[1].trim() : "";
      if (!namePart) {
        currentSalesperson = null;
        continue;
      }
      currentSalesperson = namePart.toUpperCase();
      if (!rowsBySalesperson[currentSalesperson]) {
        rowsBySalesperson[currentSalesperson] = [];
      }
      if (DEBUG_SALES) {
        console.log("⏱ New salesperson block found:", currentSalesperson);
      }
      // we DO NOT reset header here, we always use globalHeader
      continue;
    }

    // Until we have both a salesperson and a header, ignore rows
    if (!currentSalesperson || !globalHeader) {
      continue;
    }

    // 3) Skip totals / meta lines, but DO NOT skip normal detail rows
    const isRowEmpty = rowArr.every(
      (cell) => String(cell || "").trim() === ""
    );

    if (
      isRowEmpty ||
      /^total$/i.test(firstCell) ||
      /^grand total$/i.test(firstCell) ||
      /^branch\s*:/i.test(firstCell) ||
      /^period\s*:/i.test(firstCell)
    ) {
      // This is a summary / meta / blank row – skip it
      continue;
    }

    // 4) Convert this row array into an object using the GLOBAL header
    const rowObj = {};
    globalHeader.forEach((h, idx) => {
      if (!h) return;
      rowObj[String(h).trim()] = rowArr[idx];
    });

    rowsBySalesperson[currentSalesperson].push(rowObj);
  }

  if (DEBUG_SALES) {
    console.log("========================================");
    console.log(
      "📊 Salesperson blocks in this file:",
      Object.keys(rowsBySalesperson)
    );
    for (const [name, rowsArr] of Object.entries(rowsBySalesperson)) {
      console.log("  -", name, "rows:", rowsArr.length);
    }
    console.log("========================================");
  }

  const salespersonNames = Object.keys(rowsBySalesperson);
  for (const name of salespersonNames) {
    const blockRows = rowsBySalesperson[name];
    if (blockRows.length === 0) continue;
    await processRowsForSalesperson(
      blockRows,
      name,
      year,
      month,
      1,
      returnInvoiceSet
    );
  }
}

// ---------- API ROUTES ----------

// Single salesperson create/update
app.post("/api/salespersons", async (req, res) => {
  try {
    const { name, brand, section } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const sp = await upsertSalesperson(name, brand, section); // 👈 pass section
    res.json({
      id: sp._id,
      name: sp.name,
      brand: sp.brand,
      section: sp.section
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to upsert salesperson" });
  }
});


// Bulk brand update
app.post("/api/salespersons/bulk", async (req, res) => {
  try {
    const { salespersons } = req.body;
    if (!Array.isArray(salespersons)) {
      return res
        .status(400)
        .json({ error: "salespersons array is required" });
    }

    for (const item of salespersons) {
  if (!item) continue;
  const { id, name, brand, section } = item;

  let sp = null;
  if (id) {
    sp = await Salesperson.findById(id);
  } else if (name) {
    sp = await Salesperson.findOne({
      name: String(name).trim().toUpperCase()
    });
  }

  if (!sp) continue;

  sp.brand = brand ? String(brand).trim().toUpperCase() : null;
  sp.section = section ? String(section).trim().toUpperCase() : null;

  // 👈 THIS WAS MISSING
  await sp.save();
}

const updated = await Salesperson.find().sort({ name: 1 });
res.json(updated);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to bulk update salespersons" });
  }
});

// List salespersons
app.get("/api/salespersons", async (req, res) => {
  try {
    const list = await Salesperson.find().sort({ name: 1 });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch salespersons" });
  }
});

// Single target set
app.post("/api/targets", async (req, res) => {
  try {
    const { name, year, month, target } = req.body;
    if (!name || !year || !month) {
      return res
        .status(400)
        .json({ error: "name, year, month are required" });
    }

    const sp = await upsertSalesperson(name);

    const t = Number(target || 0);

    const existing = await MonthlyTarget.findOne({
      salesperson: sp._id,
      year,
      month
    });

    if (existing) {
      existing.target = t;
      await existing.save();
    } else {
      const mt = new MonthlyTarget({
        salesperson: sp._id,
        year,
        month,
        target: t
      });
      await mt.save();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to set target" });
  }
});

// Bulk targets set
app.post("/api/targets/bulk", async (req, res) => {
  try {
    const { year, month, targets } = req.body;
    if (!year || !month) {
      return res
        .status(400)
        .json({ error: "year and month are required" });
    }
    if (!Array.isArray(targets)) {
      return res
        .status(400)
        .json({ error: "targets array is required" });
    }

    for (const item of targets) {
      if (!item || !item.name) continue;
      const name = String(item.name).trim();
      const t = Number(item.target || 0);

      const sp = await upsertSalesperson(name);

      const existing = await MonthlyTarget.findOne({
        salesperson: sp._id,
        year,
        month
      });

      if (existing) {
        existing.target = t;
        await existing.save();
      } else {
        const mt = new MonthlyTarget({
          salesperson: sp._id,
          year,
          month,
          target: t
        });
        await mt.save();
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to bulk set targets" });
  }
});

// Upload Excel (all salespersons) + optional sales return list
app.post(
  "/api/upload-sales",
  upload.fields([
    { name: "salesFile", maxCount: 1 },
    { name: "returnsFile", maxCount: 1 }, // must match frontend
    { name: "file", maxCount: 1 } // optional fallback
  ]),
  async (req, res) => {
    const { year, month } = req.body;

    if (!year || !month) {
      return res.status(400).json({ error: "year and month are required" });
    }

    const yearNum = Number(year);
    const monthNum = Number(month);

    try {
      // Clear old achievements for this period
      await MonthlyAchievement.deleteMany({ year: yearNum, month: monthNum });

      const salesUploaded =
        req.files?.salesFile?.[0] || req.files?.file?.[0] || null;
      const returnsUploaded = req.files?.returnsFile?.[0] || null;

      if (!salesUploaded) {
        return res.status(400).json({ error: "Sales Excel file is required" });
      }

      // Build return invoice set (if return file exists)
      let returnInvoiceSet = new Set();
      if (returnsUploaded) {
        const returnPath = path.join(__dirname, returnsUploaded.path);
        returnInvoiceSet = extractReturnInvoiceSet(returnPath);
        fs.unlinkSync(returnPath);
      }

      // Process sales file, skipping invoices that appear in returnInvoiceSet
      const salesPath = path.join(__dirname, salesUploaded.path);
      await processExcelFileMulti(salesPath, yearNum, monthNum, returnInvoiceSet);
      fs.unlinkSync(salesPath);

      res.json({
        ok: true,
        message: "Sales processed successfully (returns used to skip invoices)"
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Dashboard
app.get("/api/dashboard", async (req, res) => {
  try {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month) {
      return res.status(400).json({
        error: "year and month query parameters are required"
      });
    }

    const salespersons = await Salesperson.find().sort({ name: 1 });
    const result = [];

    for (const sp of salespersons) {
      const targetDoc = await MonthlyTarget.findOne({
        salesperson: sp._id,
        year,
        month
      });

      const achievement = await MonthlyAchievement.findOne({
        salesperson: sp._id,
        year,
        month
      });

      const target = targetDoc?.target || 0;

      const ownAchievement = achievement?.ownAchievement || 0;
      const otherAchievement = achievement?.otherAchievement || 0;
      const totalAchievement = achievement?.totalAchievement || 0;

      const totalPercent =
        target > 0 ? (totalAchievement / target) * 100 : null;

      result.push({
  name: sp.name,
  brand: sp.brand,
  section: sp.section,   // 👈 add this
  target,
  ownAchievement,
  otherAchievement,
  totalAchievement,
  totalPercent
});

    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
