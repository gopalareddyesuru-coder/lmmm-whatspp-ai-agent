import "dotenv/config";
import express from "express";
import pg from "pg";
import fs from "fs/promises";
import path from "path";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;

const MASTER_DATA_PATH = path.join(process.cwd(), "lmmm_master_data.json");
let MASTER_DATA = null;
let MASTER_DATA_STATUS = {
  loaded: false,
  records: 0,
  loadedAt: null,
  error: null
};

// History date-range sessions. WhatsApp user must select From/To dates
// before any history records are returned.
const historySessions = new Map();
const historyPageSessions = new Map();

async function loadMasterData() {
  try {
    const raw = await fs.readFile(MASTER_DATA_PATH, "utf8");
    MASTER_DATA = JSON.parse(raw);

    let records = 0;
    if (Array.isArray(MASTER_DATA)) {
      records = MASTER_DATA.length;
    } else if (MASTER_DATA && typeof MASTER_DATA === "object") {
      for (const value of Object.values(MASTER_DATA)) {
        if (Array.isArray(value)) records += value.length;
      }
    }

    MASTER_DATA_STATUS = {
      loaded: true,
      records,
      loadedAt: new Date().toISOString(),
      error: null
    };

    console.log(`[MASTER DATA] lmmm_master_data.json loaded (${records} records)`);
  } catch (error) {
    MASTER_DATA = null;
    MASTER_DATA_STATUS = {
      loaded: false,
      records: 0,
      loadedAt: null,
      error: error?.code === "ENOENT"
        ? "FILE_NOT_FOUND"
        : "INVALID_OR_UNREADABLE_JSON"
    };

    // Do not fail the web service if the large JSON file is temporarily unavailable.
    console.error("[MASTER DATA] Load skipped:", MASTER_DATA_STATUS.error);
  }
}

/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_PERMISSIONS = [
  "data_entry",
  "view",
  "logbook_entry",
  "shutdown_jobs_entry",
  "jobs_entry",
  "vibration_readings_entry"
];

const ADDITIONAL_PERMISSIONS = [
  ["print_export", "Print / Export", "PDF / Excel / Print"],
  ["master_modify", "Master Data Modification", "Equipment / master-data changes"],
  ["analysis_reports", "Analysis / Reports", "Analytics and maintenance reports"],
  ["smp_sop_troubleshooting", "SMP/SOP/Troubleshooting/History", "Technical knowledge and history"],
  ["attendance_manpower", "Attendance / Manpower", "Employee / contract / manpower"],
  ["maintenance_modules", "Maintenance Modules", "Additional maintenance module access"],
  ["full_access", "Full Access", "All normal permissions"]
];

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
      name TEXT,
      employee_number VARCHAR(50) UNIQUE,
      designation TEXT,
      area_of_working TEXT,
      section_department TEXT,
      system_role TEXT DEFAULT 'pending',
      approval_status TEXT DEFAULT 'pending',
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_change_audit (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number VARCHAR(20),
      employee_number VARCHAR(50),
      changed_by VARCHAR(20) NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_access_scopes (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number VARCHAR(20) NOT NULL,
      employee_number VARCHAR(50),
      area_of_working TEXT NOT NULL,
      section_department TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'primary',
      granted_by VARCHAR(20),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (whatsapp_number, area_of_working, section_department)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS authority_audit (
      id BIGSERIAL PRIMARY KEY,
      target_whatsapp_number VARCHAR(20),
      target_employee_number VARCHAR(50),
      changed_by VARCHAR(20) NOT NULL,
      action TEXT NOT NULL,
      permission TEXT,
      target_area TEXT,
      target_section TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS registration_requests (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number VARCHAR(20) NOT NULL,
      name TEXT,
      employee_number VARCHAR(50),
      designation TEXT,
      area_of_working TEXT,
      section_department TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP,
      reviewed_by VARCHAR(20)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_edit_sessions (
      whatsapp_number VARCHAR(20) PRIMARY KEY,
      employee_number VARCHAR(50) NOT NULL,
      field_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      whatsapp_number VARCHAR(20),
      message_type TEXT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_submissions (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT UNIQUE,
      whatsapp_number VARCHAR(20) NOT NULL,
      employee_number VARCHAR(50),
      message_type TEXT NOT NULL,
      text_content TEXT,
      caption TEXT,
      media_id TEXT,
      mime_type TEXT,
      file_name TEXT,
      user_area TEXT,
      user_section TEXT,
      module_hint TEXT,
      equipment_name TEXT,
      sub_equipment TEXT,
      event_category TEXT,
      failure_mode TEXT,
      failure_cause TEXT,
      failure_consequence TEXT,
      maintenance_action TEXT,
      maintenance_type TEXT,
      resources_used TEXT,
      downtime_minutes NUMERIC,
      condition_data JSONB,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for an already-created maintenance_submissions table.
  // These columns are required by the scope-aware submission layer.
  const maintenanceColumns = [
    ["user_area", "TEXT"],
    ["user_section", "TEXT"],
    ["module_hint", "TEXT"],
    ["equipment_name", "TEXT"],
    ["sub_equipment", "TEXT"],
    ["event_category", "TEXT"],
    ["failure_mode", "TEXT"],
    ["failure_cause", "TEXT"],
    ["failure_consequence", "TEXT"],
    ["maintenance_action", "TEXT"],
    ["maintenance_type", "TEXT"],
    ["resources_used", "TEXT"],
    ["downtime_minutes", "NUMERIC"],
    ["condition_data", "JSONB"]
  ];

  for (const [column, type] of maintenanceColumns) {
    await pool.query(
      `ALTER TABLE maintenance_submissions ADD COLUMN IF NOT EXISTS ${column} ${type}`
    );
  }

  console.log("[DATABASE] All required tables ready");
  console.log("[AUTHORITY] Default maintenance access is internal and hidden from users");
  console.log("[MAINTENANCE] Data model aligned to equipment, failure and maintenance-event concepts from LMMM sources and ISO 14224-style reliability data collection.");

}

/* =========================================================
   META / WHATSAPP
========================================================= */

const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || "").trim();
const ACCESS_TOKEN = (process.env.META_ACCESS_TOKEN || "").trim();
const PHONE_NUMBER_ID = (
  process.env.PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID ||
  ""
).trim();
const GRAPH_API_VERSION = process.env.META_GRAPH_VERSION || "v26.0";

const OWNER_NUMBERS = new Set(
  (process.env.SUPER_ADMIN_NUMBERS || process.env.OWNER_WHATSAPP_NUMBERS || "")
    .split(",")
    .map(x => x.replace(/\D/g, ""))
    .filter(Boolean)
);

/* =========================================================
   MESSAGES
========================================================= */

const REGISTRATION_MESSAGE = `LMMM Maintenance AI 👋

Register in one message:
Name
Employee No
Designation
Area
Section

Example:
Gopala Reddy E
123125
Manager
Bar Mill
Mechanical`.trim();

function getMainMenu(user) {
  return `
Welcome back, ${user.name || "User"} 👋

LMMM Mechanical Maintenance AI Agent

Select Maintenance Field:

1️⃣ Log Book
2️⃣ Breakdown / Delay Management
3️⃣ Defect Management
4️⃣ Maintenance Jobs / Work Orders
5️⃣ Preventive Maintenance (PM)
6️⃣ Inspection & Condition Monitoring
7️⃣ CBM / Vibration Monitoring
8️⃣ Equipment Master
9️⃣ SAP Sub-Equipment
🔟 Maintenance History
1️⃣1️⃣ Spare Parts Management
1️⃣2️⃣ Drawings & Technical Documents
1️⃣3️⃣ SMP – Standard Maintenance Procedure
1️⃣4️⃣ SOP – Standard Operating Procedure
1️⃣5️⃣ Troubleshooting & Failure Analysis
1️⃣6️⃣ RCM / Reliability Management
1️⃣7️⃣ Shutdown Maintenance
1️⃣8️⃣ Employee Attendance
1️⃣9️⃣ Contract Worker Attendance
2️⃣0️⃣ Manpower / Labour Management

Reply with the Maintenance Field number.
`.trim();
}

/* =========================================================
   WHATSAPP SEND HELPERS
========================================================= */

async function sendWhatsAppText(to, message) {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: String(message).slice(0, 4000) }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("[WHATSAPP] Text send error:", data);
  }

  return data;
}

async function sendApprovalButtons(to, data) {
  const employeeNumber = data.employee_number;

  const body =
    `NEW USER REGISTRATION\n\n` +
    `👤 ${data.name}\n` +
    `🆔 ${data.employee_number}\n` +
    `💼 ${data.designation} | ${data.area_of_working}\n` +
    `🔧 ${data.section_department}\n\n` +
    `Pending Approval ⏳`;

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: `approve_${employeeNumber}`,
                  title: "Approve"
                }
              },
              {
                type: "reply",
                reply: {
                  id: `reject_${employeeNumber}`,
                  title: "Reject"
                }
              }
            ]
          }
        }
      })
    }
  );

  const result = await response.json();
  if (!response.ok) {
    console.error("[WHATSAPP] Approval button error:", result);
  }
  return result;
}

async function sendAdditionalAuthorityMenu(to, employeeNumber, permissions = [], options = {}) {
  const selected = new Set(Array.isArray(permissions) ? permissions : []);
  const statusLine = options.statusLine || "Authority Management";

  const selectedText = ADDITIONAL_PERMISSIONS
    .filter(([key]) => selected.has(key))
    .map(([, label]) => `✓ ${label}`)
    .join("\n") || "None";

  const rows = ADDITIONAL_PERMISSIONS.map(([key, label, description]) => ({
    id: `authority_${key}_${employeeNumber}`,
    title: `${selected.has(key) ? "✓ " : ""}${label}`.slice(0, 24),
    description
  }));

  rows.push({
    id: `authority_details_${employeeNumber}`,
    title: "View Current Access",
    description: "See assigned permissions"
  });

  rows.push({
    id: `authority_all_users_${employeeNumber}`,
    title: "View All User Access",
    description: "Super Admin overview"
  });

  const body =
    `${statusLine}\n` +
    `Employee ${employeeNumber}\n\n` +
    `Default: Data Entry + View + Maintenance Entry\n` +
    `Additional: ${selectedText}\n\n` +
    `Select access to assign/remove.`;

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body.slice(0, 1024) },
          action: {
            button: "Manage Authorities",
            sections: [
              {
                title: "Additional Authorities",
                rows
              }
            ]
          }
        }
      })
    }
  );

  const result = await response.json();
  if (!response.ok) {
    console.error("[WHATSAPP] Authority menu error:", result);
  }
  return result;
}

/* =========================================================
   HELPERS
========================================================= */

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[|,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGreeting(text) {
  return [
    "hi", "hello", "hey", "hii", "hiii", "start", "hai"
  ].includes(normalizeText(text));
}

function isResetCommand(text) {
  const v = normalizeText(text);

  return [
    "reset registration",
    "reset my registration",
    "reset registration details",
    "change registration",
    "correct registration"
  ].includes(v);
}

function cleanValue(value) {
  return String(value || "")
    .replace(/^[\s:.\-–—]+|[\s:.\-–—]+$/g, "")
    .trim();
}

function normalizeArea(value) {
  const v = normalizeText(value);

  if (/^bar\s*mill$|^barmill$|^bar\s*mill\s*mechanical$/.test(v)) {
    return "Bar Mill";
  }

  if (/^bdm$|^breakdown\s*mill$|^break\s*down\s*mill$|^breakdown\s*mill\s*mechanical$/.test(v)) {
    return "BDM";
  }

  if (/^finishing$|^finishing\s*mill$|^finishing\s*mechanical$/.test(v)) {
    return "Finishing";
  }

  if (/^hydraulics$|^hydraulics\s*mechanical$/.test(v)) {
    return "Hydraulics";
  }

  if (/^cranes?\s*(and|&)\s*aux(iliary)?$|^cranes?\s*&\s*aux\s*mechanical$/.test(v)) {
    return "Cranes & Auxiliary";
  }

  return cleanValue(value);
}

/* =========================================================
   REGISTRATION EXTRACTION
========================================================= */

async function extractRegistrationWithAI(text) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) return null;

  const prompt = `
Extract LMMM employee registration details from the user's message.

Required fields:
name
employee_number
designation
area_of_working
section_department

Rules:
- Return ONLY valid JSON.
- Do not invent missing values.
- Employee number should be digits only when clearly identifiable.
- Understand common spelling variations such as "Barmill" = "Bar Mill".
- Keep designation and section as stated unless the meaning is unambiguous.
- If a required field is missing or ambiguous, return null for that field.
- The WhatsApp number is NOT part of the user's message and must not be inferred.

JSON schema:
{
  "name": string|null,
  "employee_number": string|null,
  "designation": string|null,
  "area_of_working": string|null,
  "section_department": string|null
}

User message:
${text}
`.trim();

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input: prompt
      })
    });

    if (!response.ok) {
      console.error("[AI] Extraction HTTP error:", response.status);
      return null;
    }

    const data = await response.json();

    const output =
      data.output_text ||
      data.output?.flatMap(x => x.content || [])
        ?.map(x => x.text || "")
        ?.join("") ||
      "";

    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);

    return {
      name: cleanValue(parsed.name),
      employee_number: cleanValue(parsed.employee_number),
      designation: cleanValue(parsed.designation),
      area_of_working: normalizeArea(parsed.area_of_working),
      section_department: cleanValue(parsed.section_department)
    };
  } catch (error) {
    console.error("[AI] Extraction error:", error);
    return null;
  }
}

function extractRegistrationFallback(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(cleanValue)
    .filter(Boolean);

  const result = {
    name: null,
    employee_number: null,
    designation: null,
    area_of_working: null,
    section_department: null
  };

  const employeeIndex = lines.findIndex(x => /^\d{3,}$/.test(x));

  if (employeeIndex >= 0) {
    result.employee_number = lines[employeeIndex];
  }

  const designationWords = [
    "manager",
    "assistant manager",
    "deputy manager",
    "senior manager",
    "agm",
    "dgm",
    "gm",
    "executive",
    "technician",
    "engineer",
    "assistant engineer",
    "deputy general manager"
  ];

  const designationIndex = lines.findIndex(x =>
    designationWords.some(d => normalizeText(x) === d)
  );

  if (designationIndex >= 0) {
    result.designation = lines[designationIndex];
  }

  const areaIndex = lines.findIndex(x => {
    const v = normalizeText(x);

    return [
      "barmill",
      "bar mill",
      "bdm",
      "breakdown mill",
      "finishing",
      "finishing mill",
      "hydraulics",
      "cranes & auxiliary",
      "cranes and auxiliary"
    ].includes(v);
  });

  if (areaIndex >= 0) {
    result.area_of_working = normalizeArea(lines[areaIndex]);
  }

  if (lines.length >= 5) {
    result.name = lines[0];

    if (!result.employee_number && /^\d{3,}$/.test(lines[1])) {
      result.employee_number = lines[1];
    }

    if (!result.designation) result.designation = lines[2];
    if (!result.area_of_working) result.area_of_working = normalizeArea(lines[3]);

    result.section_department = lines[4];
  }

  return result;
}

async function extractRegistration(text) {
  const aiResult = await extractRegistrationWithAI(text);
  const fallback = extractRegistrationFallback(text);

  const merged = {
    name: aiResult?.name || fallback.name,
    employee_number: aiResult?.employee_number || fallback.employee_number,
    designation: aiResult?.designation || fallback.designation,
    area_of_working: aiResult?.area_of_working || fallback.area_of_working,
    section_department:
      aiResult?.section_department || fallback.section_department
  };

  if (merged.area_of_working) {
    merged.area_of_working = normalizeArea(merged.area_of_working);
  }

  return merged;
}

/* =========================================================
   REGISTRATION VALIDATION / SUBMISSION
========================================================= */

function missingRegistrationFields(data) {
  const missing = [];

  if (!data.name) missing.push("Name");
  if (!data.employee_number) missing.push("Employee Number");
  if (!data.designation) missing.push("Designation");
  if (!data.area_of_working) missing.push("Area of Working");
  if (!data.section_department) missing.push("Section / Department");

  return missing;
}

async function submitRegistration(from, data) {
  const missing = missingRegistrationFields(data);

  if (missing.length) {
    await sendWhatsAppText(
      from,
      `Missing: ${missing.join(", ")}.`
    );
    return;
  }

  if (!/^\d+$/.test(String(data.employee_number))) {
    await sendWhatsAppText(
      from,
      "Employee No must contain numbers only."
    );
    return;
  }

  try {
    const duplicate = await pool.query(
      `SELECT whatsapp_number FROM users
       WHERE employee_number = $1 AND whatsapp_number <> $2`,
      [data.employee_number, from]
    );

    if (duplicate.rowCount > 0) {
      await sendWhatsAppText(
        from,
        "Employee No already registered. Please contact Admin."
      );
      return;
    }

    await pool.query(
      `
      INSERT INTO users (
        whatsapp_number,
        name,
        employee_number,
        designation,
        area_of_working,
        section_department,
        system_role,
        approval_status,
        permissions,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,'pending','pending','[]'::jsonb,CURRENT_TIMESTAMP
      )
      ON CONFLICT (whatsapp_number)
      DO UPDATE SET
        name = EXCLUDED.name,
        employee_number = EXCLUDED.employee_number,
        designation = EXCLUDED.designation,
        area_of_working = EXCLUDED.area_of_working,
        section_department = EXCLUDED.section_department,
        system_role = 'pending',
        approval_status = 'pending',
        permissions = '[]'::jsonb,
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        from,
        data.name,
        data.employee_number,
        data.designation,
        data.area_of_working,
        data.section_department
      ]
    );

    await pool.query(
      `
      INSERT INTO registration_requests (
        whatsapp_number,
        name,
        employee_number,
        designation,
        area_of_working,
        section_department,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,'pending')
      `,
      [
        from,
        data.name,
        data.employee_number,
        data.designation,
        data.area_of_working,
        data.section_department
      ]
    );

    await sendWhatsAppText(
      from,
      "Submitted ✓\nPending Approval ⏳"
    );

    await notifyOwners(data, from);

  } catch (error) {
    console.error("[REGISTRATION] Submit error:", error);

    if (error.code === "23505") {
      await sendWhatsAppText(
        from,
        "Employee No already exists."
      );
      return;
    }

    await sendWhatsAppText(
      from,
      "Could not save. Please try again."
    );
  }
}

async function notifyOwners(data, from) {
  if (!OWNER_NUMBERS.size) {
    console.log(
      "[APPROVAL] SUPER_ADMIN_NUMBERS not configured; owner notification skipped."
    );
    return;
  }

  // One clean approval card only. This removes the duplicate text + button messages.
  for (const owner of OWNER_NUMBERS) {
    await sendApprovalButtons(owner, data);
  }
}

/* =========================================================
   RESET
========================================================= */

async function resetRegistration(from) {
  await pool.query(
    `
    UPDATE users
    SET name = NULL,
        employee_number = NULL,
        designation = NULL,
        area_of_working = NULL,
        section_department = NULL,
        system_role = 'pending',
        approval_status = 'pending',
        permissions = '[]'::jsonb,
        updated_at = CURRENT_TIMESTAMP
    WHERE whatsapp_number = $1
    `,
    [from]
  );

  await pool.query(
    `DELETE FROM admin_edit_sessions WHERE whatsapp_number=$1`,
    [from]
  );

  await sendWhatsAppText(from, REGISTRATION_MESSAGE);
}

/* =========================================================
   SCOPE-BASED ACCESS CONTROL
   Area + Section is the data boundary.
========================================================= */

function cleanScopeValue(value) {
  return normalizeText(value)
    .replace(/\s*&\s*/g, " & ")
    .trim();
}

function sameScope(a, b) {
  return (
    cleanScopeValue(a?.area_of_working) === cleanScopeValue(b?.area_of_working) &&
    cleanScopeValue(a?.section_department) === cleanScopeValue(b?.section_department)
  );
}

function isHODUser(user) {
  const role = normalizeText(user?.system_role);
  const designation = normalizeText(user?.designation);
  return role === "hod" || /\bhod\b|head\s*of\s*department/.test(designation);
}

function isSectionInchargeUser(user) {
  const role = normalizeText(user?.system_role);
  const designation = normalizeText(user?.designation);
  return (
    role === "section_incharge" ||
    role === "section incharge" ||
    /section\s*incharge|section\s*in\s*charge/.test(designation)
  );
}

function isScopeAuthorityManager(user, from) {
  if (isSuperAdmin(from)) return true;
  return isHODUser(user) || isSectionInchargeUser(user);
}

function canAccessUserRecord(actor, target) {
  if (!actor || !target) return false;
  if (isSuperAdmin(actor.whatsapp_number)) return true;

  // Scope boundary: Area + Section.
  if (isHODUser(actor)) {
    return cleanScopeValue(actor.area_of_working) === cleanScopeValue(target.area_of_working);
  }

  if (isSectionInchargeUser(actor)) {
    return sameScope(actor, target);
  }

  return sameScope(actor, target);
}

async function canGrantAuthority(from, targetEmployeeNumber) {
  if (isSuperAdmin(from)) return true;

  const actorResult = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1 AND approval_status='approved'`,
    [from]
  );
  const targetResult = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1 AND approval_status='approved'`,
    [targetEmployeeNumber]
  );

  if (!actorResult.rowCount || !targetResult.rowCount) return false;

  const actor = actorResult.rows[0];
  const target = targetResult.rows[0];

  if (!isScopeAuthorityManager(actor, from)) return false;
  return canAccessUserRecord(actor, target);
}

async function ensurePrimaryScope(user, grantedBy = null) {
  if (!user?.whatsapp_number || !user?.area_of_working || !user?.section_department) {
    return;
  }

  await pool.query(
    `
    INSERT INTO user_access_scopes
      (whatsapp_number, employee_number, area_of_working, section_department, scope_type, granted_by, active, updated_at)
    VALUES ($1,$2,$3,$4,'primary',$5,TRUE,CURRENT_TIMESTAMP)
    ON CONFLICT (whatsapp_number, area_of_working, section_department)
    DO UPDATE SET
      employee_number=EXCLUDED.employee_number,
      active=TRUE,
      updated_at=CURRENT_TIMESTAMP
    `,
    [
      user.whatsapp_number,
      user.employee_number || null,
      user.area_of_working,
      user.section_department,
      grantedBy
    ]
  );
}

async function getScopedUsers(actor) {
  if (!actor) return [];

  if (isSuperAdmin(actor.whatsapp_number)) {
    const result = await pool.query(
      `SELECT * FROM users WHERE approval_status='approved' ORDER BY employee_number`
    );
    return result.rows;
  }

  let result;

  if (isHODUser(actor)) {
    result = await pool.query(
      `SELECT * FROM users
       WHERE approval_status='approved'
         AND lower(trim(area_of_working)) = lower(trim($1))
       ORDER BY employee_number`,
      [actor.area_of_working]
    );
  } else {
    result = await pool.query(
      `SELECT * FROM users
       WHERE approval_status='approved'
         AND lower(trim(area_of_working)) = lower(trim($1))
         AND lower(trim(section_department)) = lower(trim($2))
       ORDER BY employee_number`,
      [actor.area_of_working, actor.section_department]
    );
  }

  return result.rows;
}

function hasPermission(user, permission) {
  const permissions = Array.isArray(user?.permissions)
    ? user.permissions
    : [];

  return (
    permissions.includes("full_access") ||
    permissions.includes(permission)
  );
}

async function processAuthorityAction(from, actionId) {
  const detailsMatch = actionId.match(/^authority_details_(\\d+)$/i);
  if (detailsMatch) {
    const employeeNumber = detailsMatch[1];
    const allowed = await canGrantAuthority(from, employeeNumber);
    if (!allowed) {
      await sendWhatsAppText(from, "Access restricted.");
      return true;
    }
    await sendAuthorityDetails(from, employeeNumber);
    return true;
  }

  const allUsersMatch = actionId.match(/^authority_all_users_(\\d+)$/i);
  if (allUsersMatch) {
    const actorResult = await pool.query(
      `SELECT * FROM users WHERE whatsapp_number=$1 AND approval_status='approved'`,
      [from]
    );
    const actor = actorResult.rows[0];

    if (!isSuperAdmin(from) && !(actor && isScopeAuthorityManager(actor, from))) {
      await sendWhatsAppText(from, "Access restricted.");
      return true;
    }

    await sendAllAuthorityDetails(from);
    return true;
  }

  const match = actionId.match(
    /^authority_(print_export|master_modify|analysis_reports|smp_sop_troubleshooting|attendance_manpower|maintenance_modules|full_access)_(\d+)$/i
  );

  if (!match) return false;

  const permission = match[1].toLowerCase();
  const employeeNumber = match[2];

  const allowed = await canGrantAuthority(from, employeeNumber);
  if (!allowed) {
    await sendWhatsAppText(from, "Access restricted.");
    return true;
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(
      from,
      `No user found for Employee Number ${employeeNumber}.`
    );
    return true;
  }

  const user = result.rows[0];

  if (user.approval_status !== "approved") {
    await sendWhatsAppText(
      from,
      `Approve Employee ${employeeNumber} first.`
    );
    return true;
  }

  let permissions = Array.isArray(user.permissions)
    ? [...user.permissions]
    : [];

  if (permission === "full_access") {
    const alreadyFull = permissions.includes("full_access");

    if (alreadyFull) {
      permissions = DEFAULT_PERMISSIONS.slice();
    } else {
      permissions = [
        ...new Set([
          ...DEFAULT_PERMISSIONS,
          "full_access",
          ...ADDITIONAL_PERMISSIONS
            .map(([key]) => key)
            .filter(key => key !== "full_access")
        ])
      ];
    }
  } else {
    const index = permissions.indexOf(permission);

    if (index >= 0) {
      permissions.splice(index, 1);
    } else {
      permissions.push(permission);
    }

    permissions = [...new Set(permissions)];
  }

  await pool.query(
    `
    UPDATE users
    SET permissions=$1::jsonb,
        updated_at=CURRENT_TIMESTAMP
    WHERE employee_number=$2
    `,
    [JSON.stringify(permissions), employeeNumber]
  );

  await pool.query(
    `
    INSERT INTO user_change_audit
      (whatsapp_number, employee_number, changed_by, field_name, old_value, new_value)
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      user.whatsapp_number,
      employeeNumber,
      from,
      "permissions",
      JSON.stringify(user.permissions || []),
      JSON.stringify(permissions)
    ]
  );

  await pool.query(
    `
    INSERT INTO authority_audit
      (target_whatsapp_number, target_employee_number, changed_by, action, permission, target_area, target_section)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      user.whatsapp_number,
      employeeNumber,
      from,
      user.permissions?.includes(permission) ? "revoke" : "grant",
      permission,
      user.area_of_working,
      user.section_department
    ]
  );

  await sendAdditionalAuthorityMenu(from, employeeNumber, permissions);

  return true;
}

/* =========================================================
   OWNER APPROVAL
========================================================= */

async function processApprovalCommand(from, text) {
  if (!OWNER_NUMBERS.has(from.replace(/\D/g, ""))) {
    return false;
  }

  const approve = text.match(/^approve\s+(\d+)$/i);
  const reject = text.match(/^reject\s+(\d+)$/i);

  if (!approve && !reject) return false;

  const employeeNumber = (approve || reject)[1];
  const action = approve ? "approve" : "reject";

  return processApprovalAction(from, action, employeeNumber);
}

async function processApprovalAction(from, action, employeeNumber) {
  if (!OWNER_NUMBERS.has(from.replace(/\D/g, ""))) {
    await sendWhatsAppText(
      from,
      "Not authorised."
    );
    return true;
  }

  const status = action === "approve" ? "approved" : "rejected";

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number = $1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(
      from,
      `No registration found for Employee Number ${employeeNumber}.`
    );
    return true;
  }

  const user = result.rows[0];

  if (status === "approved") {
    /*
      Approval gives every normal user the baseline permissions.
      Additional authorities are optional and can be assigned after approval.
    */
    await pool.query(
      `
      UPDATE users
      SET approval_status='approved',
          system_role='user',
          permissions=$1::jsonb,
          updated_at=CURRENT_TIMESTAMP
      WHERE employee_number=$2
      `,
      [JSON.stringify(DEFAULT_PERMISSIONS), employeeNumber]
    );

    const approvedUserResult = await pool.query(
      `SELECT * FROM users WHERE employee_number=$1`,
      [employeeNumber]
    );
    if (approvedUserResult.rowCount) {
      await ensurePrimaryScope(approvedUserResult.rows[0], from);
    }
  } else {
    await pool.query(
      `
      UPDATE users
      SET approval_status='rejected',
          system_role='pending',
          updated_at=CURRENT_TIMESTAMP
      WHERE employee_number=$1
      `,
      [employeeNumber]
    );
  }

  await pool.query(
    `
    UPDATE registration_requests
    SET status=$1,
        reviewed_at=CURRENT_TIMESTAMP,
        reviewed_by=$2
    WHERE employee_number=$3
      AND status='pending'
    `,
    [status, from, employeeNumber]
  );

  if (status === "approved") {
    await sendWhatsAppText(
      user.whatsapp_number,
      `Approved ✓\n` +
      `Welcome, ${user.name}.\n\n` +
      `Send maintenance details directly.`
    );

    // One clean Super Admin authority-management message after approval.
    await sendAdditionalAuthorityMenu(
      from,
      employeeNumber,
      DEFAULT_PERMISSIONS,
      { statusLine: `Employee ${employeeNumber}: APPROVED ✓` }
    );

  } else {
    await sendWhatsAppText(
      user.whatsapp_number,
      `Rejected ❌\nPlease contact Admin.`
    );

    await sendWhatsAppText(
      from,
      `Rejected ✓\nEmployee ${employeeNumber}`
    );
  }

  return true;
}

/* =========================================================
   SUPER ADMIN AUTHORITY VISIBILITY
========================================================= */

function isSuperAdmin(from) {
  return OWNER_NUMBERS.has(String(from || "").replace(/\D/g, ""));
}

function additionalAuthorityLabels(permissions) {
  const set = new Set(Array.isArray(permissions) ? permissions : []);
  return ADDITIONAL_PERMISSIONS
    .filter(([key]) => set.has(key))
    .map(([, label]) => label);
}

async function sendAuthorityDetails(to, employeeNumber) {
  const actorResult = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1 AND approval_status='approved'`,
    [to]
  );

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(to, "Access restricted.");
    return true;
  }

  const user = result.rows[0];
  const actor = actorResult.rows[0];

  if (!isSuperAdmin(to) && !canAccessUserRecord(actor, user)) {
    await sendWhatsAppText(to, "Access restricted.");
    return true;
  }

  const extra = additionalAuthorityLabels(user.permissions);

  await sendWhatsAppText(
    to,
    `USER AUTHORITY DETAILS\n\n` +
    `Name: ${user.name || "-"}\n` +
    `Employee No: ${user.employee_number || "-"}\n` +
    `Designation: ${user.designation || "-"}\n` +
    `Area: ${user.area_of_working || "-"}\n` +
    `Section: ${user.section_department || "-"}\n` +
    `Status: ${user.approval_status || "-"}\n\n` +
    `Default maintenance access: ENABLED\n` +
    `Additional authorities:\n` +
    (extra.length ? extra.map(x => `✓ ${x}`).join("\n") : "None")
  );

  return true;
}

async function sendAllAuthorityDetails(to) {
  const actorResult = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1 AND approval_status='approved'`,
    [to]
  );

  if (!actorResult.rowCount && !isSuperAdmin(to)) {
    await sendWhatsAppText(to, "Access restricted.");
    return true;
  }

  const actor = actorResult.rows[0] || null;
  const scopedUsers = await getScopedUsers(actor);

  if (!scopedUsers.length) {
    await sendWhatsAppText(to, "No registered users found.");
    return true;
  }

  const lines = ["ALL USER AUTHORITIES", ""];

  for (const user of scopedUsers) {
    const extra = additionalAuthorityLabels(user.permissions);
    lines.push(
      `${user.employee_number} - ${user.name || "-"}`,
      `Status: ${user.approval_status || "-"}`,
      `Default Maintenance Access: ${user.approval_status === "approved" ? "YES" : "NO"}`,
      `Additional: ${extra.length ? extra.join(", ") : "None"}`,
      ""
    );
  }

  await sendWhatsAppText(to, lines.join("\n"));
  return true;
}

/* =========================================================
   USER MANAGEMENT
========================================================= */

async function sendUserManagementMenu(to, employeeNumber) {
  if (!OWNER_NUMBERS.has(to.replace(/\D/g, ""))) {
    await sendWhatsAppText(
      to,
      "You are not authorised to modify user details."
    );
    return true;
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(
      to,
      `No user found for Employee Number ${employeeNumber}.`
    );
    return true;
  }

  const user = result.rows[0];

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "list",
          body: {
            text:
              `Manage Employee ${employeeNumber}\n\n` +
              `Name: ${user.name || "-"}\n` +
              `Designation: ${user.designation || "-"}\n` +
              `Area: ${user.area_of_working || "-"}\n` +
              `Section: ${user.section_department || "-"}`
          },
          action: {
            button: "Modify User",
            sections: [
              {
                title: "User Details",
                rows: [
                  {
                    id: `edit_designation_${employeeNumber}`,
                    title: "Designation",
                    description: "Change designation"
                  },
                  {
                    id: `edit_area_${employeeNumber}`,
                    title: "Area of Working",
                    description: "Change working area"
                  },
                  {
                    id: `edit_section_${employeeNumber}`,
                    title: "Section / Department",
                    description: "Change section/department"
                  }
                ]
              }
            ]
          }
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("[WHATSAPP] User management menu error:", data);
  }

  return true;
}

async function startUserEdit(from, actionId) {
  const match = actionId.match(
    /^edit_(designation|area|section)_(\d+)$/i
  );

  if (!match) return false;

  if (!OWNER_NUMBERS.has(from.replace(/\D/g, ""))) {
    await sendWhatsAppText(
      from,
      "You are not authorised to modify user details."
    );
    return true;
  }

  const field = match[1].toLowerCase();
  const employeeNumber = match[2];

  const label =
    field === "designation"
      ? "Designation"
      : field === "area"
        ? "Area of Working"
        : "Section / Department";

  await sendWhatsAppText(
    from,
    `Send the new ${label} for Employee ${employeeNumber}.`
  );

  await pool.query(
    `
    INSERT INTO admin_edit_sessions
      (whatsapp_number, employee_number, field_name)
    VALUES ($1,$2,$3)
    ON CONFLICT (whatsapp_number)
    DO UPDATE SET
      employee_number=EXCLUDED.employee_number,
      field_name=EXCLUDED.field_name,
      created_at=CURRENT_TIMESTAMP
    `,
    [from, employeeNumber, field]
  );

  return true;
}

async function processAdminEditText(from, text) {
  if (!OWNER_NUMBERS.has(from.replace(/\D/g, ""))) {
    return false;
  }

  const result = await pool.query(
    `SELECT * FROM admin_edit_sessions WHERE whatsapp_number=$1`,
    [from]
  );

  if (!result.rowCount) return false;

  const session = result.rows[0];
  const value = String(text || "").trim();

  if (!value) {
    await sendWhatsAppText(from, "Please enter a valid value.");
    return true;
  }

  const userResult = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
    [session.employee_number]
  );

  if (!userResult.rowCount) {
    await sendWhatsAppText(
      from,
      `No user found for Employee Number ${session.employee_number}.`
    );

    await pool.query(
      `DELETE FROM admin_edit_sessions WHERE whatsapp_number=$1`,
      [from]
    );

    return true;
  }

  const user = userResult.rows[0];

  const columnMap = {
    designation: "designation",
    area: "area_of_working",
    section: "section_department"
  };

  const column = columnMap[session.field_name];
  const oldValue = user[column];

  const newValue =
    session.field_name === "area"
      ? normalizeArea(value)
      : value;

  await pool.query(
    `
    UPDATE users
    SET ${column}=$1,
        updated_at=CURRENT_TIMESTAMP
    WHERE employee_number=$2
    `,
    [newValue, session.employee_number]
  );

  await pool.query(
    `
    INSERT INTO user_change_audit
      (whatsapp_number, employee_number, changed_by, field_name, old_value, new_value)
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      user.whatsapp_number,
      session.employee_number,
      from,
      session.field_name,
      oldValue,
      newValue
    ]
  );

  await pool.query(
    `DELETE FROM admin_edit_sessions WHERE whatsapp_number=$1`,
    [from]
  );

  await sendWhatsAppText(
    from,
    `Employee ${session.employee_number} updated successfully ✅\n` +
    `${session.field_name}: ${newValue}`
  );

  return true;
}

/* =========================================================
   REGISTRATION FLOW
========================================================= */

async function processRegistration(from, text) {
  const result = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1`,
    [from]
  );

  const user = result.rows[0];

  if (!user) {
    await pool.query(
      `INSERT INTO users (whatsapp_number) VALUES ($1)`,
      [from]
    );

    await sendWhatsAppText(from, REGISTRATION_MESSAGE);
    return;
  }

  const data = await extractRegistration(text);
  const missing = missingRegistrationFields(data);

  if (!missing.length) {
    await submitRegistration(from, data);
    return;
  }

  await sendWhatsAppText(from, `Missing: ${missing.join(", ")}.`);
}

function getReplyLanguage(text) {
  const value = String(text || "");
  if (/[\u0C00-\u0C7F]/.test(value)) return "te";
  const lower = value.toLowerCase();
  if (lower.includes("telugu lo") || lower.includes("telugu language")) return "te";
  return "en";
}

function getShortMaintenanceAck(text) {
  if (getReplyLanguage(text) === "te") {
    return "సేవ్ చేశాను ✓\nమెయింటెనెన్స్ వివరాలు నమోదు అయ్యాయి.";
  }
  return "Saved ✓\nMaintenance details recorded.";
}

/* =========================================================
   MASTER DATA QUERY + SCOPE GATE
   Natural-language maintenance queries are handled here before
   they can fall through to the generic "save submission" path.
========================================================= */

const AREA_ALIASES = [
  ["BDM", /\b(?:bdm|breakdown\s*mill|break\s*down\s*mill)\b/i],
  ["Bar Mill", /\b(?:bar\s*mill|barmill|bm)\b/i],
  ["Finishing", /\b(?:finishing|finishing\s*mill)\b/i],
  ["Hydraulics", /\bhydraulics\b/i],
  ["Cranes & Auxiliary", /\b(?:cranes?\s*(?:&|and)\s*aux(?:iliary)?)\b/i]
];

function detectRequestedArea(text) {
  const value = String(text || "");
  for (const [area, re] of AREA_ALIASES) {
    if (re.test(value)) return area;
  }
  return null;
}

function scopeAreaMatches(user, requestedArea) {
  if (!requestedArea) return true;
  if (isSuperAdmin(user?.whatsapp_number)) return true;
  return cleanScopeValue(user?.area_of_working) === cleanScopeValue(requestedArea);
}

function formatHistoryRecord(x) {
  return `${x.source || "History"}\n${x.text || ""}`.trim();
}

function historySourceTable(source) {
  const value = String(source || "");
  const m = value.match(/\/\s*([^/]+)_Table\s*1$/i);
  return m ? m[1].trim() : value;
}

function isHistoryHeaderRecord(text) {
  const raw = String(text || "").trim();
  const value = raw.toUpperCase().replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (/^(SNO|SL NO|SLNO|EQPMT|EQPMNT|EQUMT)\s*\|/.test(value)) return true;
  if (/^(BSY ROLLER TABLE|FURNACE APPROACH ROLLER TABLE|CHARGING GRIDS|BLOOM PUSHER GUIDE WHEEL CHANGING|CENTERSCREEN HISTORY|HISTORY OF LINTEL REPLACEMENT|DOOR SPROCKETS REPLACEMENT HISTORY|PULLEYS REPLACEMENT HISTORY|ECS TURBINES MAINTENANCE HISTORY|WALKING BEAM FURNACE GEARBOXES REPLACEMENT HISTORY)$/.test(value)) return true;
  return false;
}

function normalizeHistoryQuery(value) {
  return normalizeHistoryEquipmentToken(String(value || ""))
    .replace(/\b(?:history|historical|records?|show|give|tell|please|all|jobs?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function historyQueryAliases(query) {
  const q = normalizeHistoryEquipmentToken(query);
  const aliases = new Set([q]);
  const add = (v) => { if (v) aliases.add(normalizeHistoryEquipmentToken(v)); };

  // Common maintenance shorthand / typo-tolerant aliases. Aliases never
  // create or change an authenticated Equipment No / Item No.
  if (/^(?:bp|pb|bloom\s*pusher)(?:\s*[- ]?([12]))?$/.test(q)) {
    const n = q.match(/([12])$/)?.[1];
    if (n) {
      add(`BP-${n}`); add(`PB-${n}`); add(`BP ${n}`); add(`PB ${n}`);
      add(`bloom pusher-${n}`); add(`bloom pusher ${n}`);
    } else {
      add("bp-1"); add("bp-2"); add("pb-1"); add("pb-2");
      add("bloom pusher-1"); add("bloom pusher-2");
    }
  }
  if (/^(?:elev|elevator|lift|inclined\s*elevator)(?:\s*[- ]?([12]))?$/.test(q)) {
    const n = q.match(/([12])$/)?.[1];
    if (n) { add(`ELEVATOR-${n}`); add(`elev-${n}`); add(`inclined elevator ${n}`); }
    else { add("elevator-1"); add("elevator-2"); }
  }
  if (/^(?:cg|ch\s*grid|char\.?\s*grid|charing\s*grid|charging\s*grid|charging\s*grids?)(?:\s*[- ]?([123]))?$/.test(q)) {
    const n = q.match(/([123])$/)?.[1];
    if (n) { add(`CHARGING GRID-${n}`); add(`char. grid ${n}`); add(`charing grid ${n}`); add(`cg-${n}`); }
    else { add("charging grid-1"); add("charging grid-2"); add("charging grid-3"); }
  }
  if (/^bsy(?:\s*rt|\s*roller\s*table)?$/.test(q)) { add("bsy rt"); add("bsy roller table"); add("bsyrt"); }
  if (/^(?:fart|furnace\s*approach\s*roller\s*table)$/.test(q)) { add("fart"); add("furnace approach roller table"); }
  if (/^(?:wbf|walking\s*beam\s*furnace)(?:\s*[- ]?([12]))?$/.test(q)) {
    const n = q.match(/([12])$/)?.[1];
    if (n) { add(`wbf-${n}`); add(`walking beam furnace ${n}`); }
    else { add("wbf-1"); add("wbf-2"); }
  }
  if (/^(?:ecs|evaporative\s*cooling\s*system)(?:\s*[- ]?([12]))?$/.test(q)) {
    const n = q.match(/([12])$/)?.[1];
    if (n) { add(`ecs-${n}`); add(`evaporative cooling system ${n}`); }
    else { add("ecs-1"); add("ecs-2"); }
  }
  if (/^(?:flying\s*shear|fs)$/.test(q)) { add("flying shear"); add("fs"); }
  return [...aliases].filter(Boolean);
}

function compactHistoryToken(value) {
  return normalizeHistoryEquipmentToken(value).replace(/[^a-z0-9]/g, "");
}

function historyEditDistance(a, b) {
  const x = compactHistoryToken(a), y = compactHistoryToken(b);
  if (x === y) return 0;
  if (!x || !y) return 999;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)
      );
      // Adjacent transposition: PB1 <-> BP1, etc.
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        cur[j] = Math.min(cur[j], (i > 2 ? prev[j - 2] : 0) + 1);
      }
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[y.length];
}

function fuzzyHistoryEquipmentMatch(query, equipment, aliases = []) {
  const eq = normalizeHistoryEquipmentToken(equipment);
  const target = compactHistoryToken(eq);
  if (!target || target === "na") return false;

  const equipmentNames = [eq];
  const m = eq.match(/^(BP|ELEVATOR|LTP|BTD|WBF|ECS|CHARGING GRID)-(\d+)$/i);
  if (m) {
    const family = m[1].toUpperCase();
    const n = m[2];
    if (family === "BP") equipmentNames.push(`bloom pusher ${n}`, `bp ${n}`, `pb ${n}`);
    if (family === "ELEVATOR") equipmentNames.push(`elevator ${n}`, `elev ${n}`, `inclined elevator ${n}`);
    if (family === "LTP") equipmentNames.push(`ltp ${n}`);
    if (family === "BTD") equipmentNames.push(`btd ${n}`, `bloom take off device ${n}`);
    if (family === "WBF") equipmentNames.push(`walking beam furnace ${n}`, `wbf ${n}`);
    if (family === "ECS") equipmentNames.push(`evaporative cooling system ${n}`, `ecs ${n}`);
    if (family === "CHARGING GRID") equipmentNames.push(`charging grid ${n}`, `charing grid ${n}`, `char grid ${n}`, `cg ${n}`);
  } else if (eq === "BSY RT") {
    equipmentNames.push("bsy roller table", "bsy rt");
  } else if (eq === "FART") {
    equipmentNames.push("furnace approach roller table", "fart");
  }

  const candidates = [query, ...aliases].filter(Boolean);
  for (const c of candidates) {
    const cc = compactHistoryToken(c);
    if (!cc) continue;
    for (const name of equipmentNames) {
      const nn = compactHistoryToken(name);
      if (cc === nn || cc.includes(nn) || nn.includes(cc)) return true;
      const d = historyEditDistance(cc, nn);
      const threshold = nn.length <= 5 ? 1 : nn.length <= 10 ? 2 : nn.length <= 16 ? 3 : 4;
      if (d <= threshold) return true;
    }
  }
  return false;
}

function buildHistoryEquipmentIndex(records) {
  const labels = new Map();
  let bp = null;
  let grid = null;
  for (const record of records) {
    const table = historySourceTable(String(record?.source || "")).toUpperCase();
    const text = String(record?.text || "").replace(/\s+/g, " ").trim();
    const upper = text.toUpperCase();

    if (table === "BP") {
      const m = upper.match(/^BP\s*[- ]?([12])\b/);
      if (m) bp = `BP-${m[1]}`;
      labels.set(record, bp || canonicalHistoryEquipment(record));
      continue;
    }
    if (table === "CH GRIDS") {
      const m = upper.match(/^CHAR\.?\s*GRID\s*[- ]?([123])\b/);
      if (m) grid = `CHARGING GRID-${m[1]}`;
      labels.set(record, grid || canonicalHistoryEquipment(record));
      continue;
    }
    labels.set(record, canonicalHistoryEquipment(record));
  }
  return labels;
}

function historyRecordSearchText(record) {
  return normalizeText(`${record?.text || ""} ${record?.source || ""}`);
}

function searchMasterHistory(query, requestedArea) {
  if (!MASTER_DATA?.history || !Array.isArray(MASTER_DATA.history)) return [];

  if (requestedArea === "BDM") {
    let records = MASTER_DATA.history.filter(x => {
      const source = String(x.source || "");
      return /^(?:CH SIDE HISTORY\.xlsx|WBF HISTORY 10-20\.xlsx)\s*\//i.test(source);
    });
    records = records.filter(x => !isHistoryHeaderRecord(String(x.text || "").trim()));

    const equipmentIndex = buildHistoryEquipmentIndex(records);
    for (const record of records) record.__historyEquipment = equipmentIndex.get(record) || "NA";

    const q = normalizeHistoryQuery(query);
    if (!q) return records;

    // First identify a specific equipment. Exact aliases are preferred, then
    // controlled fuzzy matching handles PB1/BP1, BP 1/BP-1, small typos, etc.
    const aliases = historyQueryAliases(q);
    const equipmentFiltered = records.filter(record => {
      const eq = record.__historyEquipment || "NA";
      return aliases.some(a => normalizeHistoryEquipmentToken(a) === normalizeHistoryEquipmentToken(eq))
        || fuzzyHistoryEquipmentMatch(q, eq, aliases);
    });
    if (equipmentFiltered.length) return equipmentFiltered;

    // Otherwise this is a maintenance-content search. Search the complete
    // record text so words appearing in job/action/remarks are all searchable.
    const terms = q.split(/\s+/).filter(Boolean);
    return records.filter(x => {
      const haystack = historyRecordSearchText(x);
      return terms.every(term => haystack.includes(normalizeText(term)));
    });
  }

  // No trusted imported history-source mapping exists for Bar Mill/Finishing.
  if (requestedArea === "Finishing" || requestedArea === "Bar Mill") return [];
  return [];
}

/* =========================================================
   HISTORY DATE RANGE
========================================================= */

function parseHistoryDate(value) {
  let text = String(value || "").trim();

  // Accept source cells such as "2016-05-06 00:00:00" and
  // "08/08/2015(CR)" without altering the stored source text.
  const token = text.match(/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4}/);
  if (!token) return null;
  text = token[0];

  let m = text.match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() === Number(m[1]) &&
        d.getUTCMonth() === Number(m[2]) - 1 &&
        d.getUTCDate() === Number(m[3])) return d;
  }

  m = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCFullYear() === Number(m[3]) &&
        d.getUTCMonth() === Number(m[2]) - 1 &&
        d.getUTCDate() === Number(m[1])) return d;
  }

  m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCFullYear() === Number(m[3]) &&
        d.getUTCMonth() === Number(m[2]) - 1 &&
        d.getUTCDate() === Number(m[1])) return d;
  }

  return null;
}


function formatHistoryDate(date) {
  if (!date) return "—";
  return `${String(date.getUTCDate()).padStart(2, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${date.getUTCFullYear()}`;
}

function extractHistoryDates(record) {
  const text = String(record?.text || "");
  const out = [];
  const seen = new Set();
  const patterns = [
    /\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b/g,
    /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const parsed = parseHistoryDate(m[0]);
      if (parsed) {
        const key = parsed.toISOString().slice(0, 10);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(parsed);
        }
      }
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

function extractHistoryDate(record) {
  return extractHistoryDates(record)[0] || null;
}


function startHistoryDateSession(from, area, query = "") {
  historySessions.set(from, {
    area,
    step: "FROM_DATE",
    fromDate: null,
    toDate: null,
    query
  });
}

function historyDatePrompt(session) {
  if (session.step === "FROM_DATE") {
    return `MAINTENANCE HISTORY – ${session.area}\n\nFrom date:\nDD-MM-YYYY`;
  }

  return `MAINTENANCE HISTORY – ${session.area}\n\nFrom date: ${formatHistoryDate(session.fromDate)} ✓\n\nTo date:\nDD-MM-YYYY`;
}

async function processHistoryDateSession(from, text, user) {
  const session = historySessions.get(from);
  if (!session) return false;

  const value = String(text || "").trim();
  const parsed = parseHistoryDate(value);

  if (!parsed) {
    await sendWhatsAppText(from, "Invalid date.\n\nPlease use DD-MM-YYYY.");
    return true;
  }

  if (session.step === "FROM_DATE") {
    session.fromDate = parsed;
    session.step = "TO_DATE";
    await sendWhatsAppText(from, historyDatePrompt(session));
    return true;
  }

  if (parsed < session.fromDate) {
    await sendWhatsAppText(from, "To date cannot be before From date.");
    return true;
  }

  session.toDate = parsed;
  historySessions.delete(from);

  await sendWhatsAppText(
    from,
    `Searching ${session.area} history...\n${formatHistoryDate(session.fromDate)} → ${formatHistoryDate(session.toDate)}`
  );

  return await sendHistoryDateRange(from, session.area, session.fromDate, session.toDate, user, session.query);
}

function historyDateMatches(record, fromDate, toDate) {
  return extractHistoryDates(record).some(d => d >= fromDate && d <= toDate);
}

function historyRowsForDisplay(records, offset = 0, pageSize = 20) {
  return historyTableRows(records.slice(offset, offset + pageSize));
}

async function sendHistoryResults(from, area, records, user, options = {}) {
  const { fromDate = null, toDate = null, queryLabel = "ALL BDM EQUIPMENT" } = options;
  const pageSize = 20;
  historyPageSessions.set(from, { area, records, offset: 0, pageSize, fromDate, toDate, queryLabel });

  const rows = historyRowsForDisplay(records, 0, pageSize);
  const lines = [
    `MAINTENANCE HISTORY – ${area}`,
    fromDate && toDate ? `${formatHistoryDate(fromDate)} → ${formatHistoryDate(toDate)}` : "All available records",
    "",
    `${queryLabel}`,
    "",
    `Showing 1–${Math.min(pageSize, records.length)} of ${records.length} records`,
    ""
  ];

  for (const r of rows) {
    const id = r.equipmentNo || r.itemNo || "NA";
    lines.push(`${r.no} | ${id} | ${r.equipment} | ${r.date}`);
    lines.push(`   ${r.description}${r.remarks !== "-" ? ` | ${r.remarks}` : ""}`);
  }

  if (records.length > pageSize) {
    lines.push("", `Reply MORE for next ${pageSize}.`);
  }
  lines.push("", `Total Records: ${records.length}`);

  // Send the WhatsApp page first; PDF generation must never delay the main answer.
  await sendWhatsAppText(from, lines.join("\n"));

  if (isSuperAdmin(from) || hasPermission(user, "print_export")) {
    setImmediate(async () => {
      try {
        const pdf = buildHistoryTablePdf(
          `LMMM ${area} Maintenance History`,
          fromDate,
          toDate,
          records
        );
        const safeFrom = fromDate ? formatHistoryDate(fromDate) : "ALL";
        const safeTo = toDate ? formatHistoryDate(toDate) : "ALL";
        const filename = `LMMM_${area.replace(/[^A-Za-z0-9]+/g, "_")}_History_${safeFrom}_to_${safeTo}.pdf`;
        const sent = await uploadWhatsAppPdf(
          from,
          pdf,
          filename,
          `Full ${area} history – ${queryLabel}`
        );
        if (!sent) console.error("[PDF] Could not send history PDF");
      } catch (error) {
        console.error("[PDF] History background generation failed:", error);
      }
    });
  }

  return true;
}

async function sendNextHistoryPage(from) {
  const session = historyPageSessions.get(from);
  if (!session) return false;

  const nextOffset = session.offset + session.pageSize;
  if (nextOffset >= session.records.length) {
    await sendWhatsAppText(from, "No more history records.");
    return true;
  }

  session.offset = nextOffset;
  const rows = historyRowsForDisplay(session.records, nextOffset, session.pageSize);
  const lines = [
    `MAINTENANCE HISTORY – ${session.area}`,
    session.fromDate && session.toDate
      ? `${formatHistoryDate(session.fromDate)} → ${formatHistoryDate(session.toDate)}`
      : "All available records",
    "",
    `Showing ${nextOffset + 1}–${Math.min(nextOffset + session.pageSize, session.records.length)} of ${session.records.length} records`,
    ""
  ];

  for (const r of rows) {
    const id = r.equipmentNo || r.itemNo || "NA";
    lines.push(`${nextOffset + r.no} | ${id} | ${r.equipment} | ${r.date}`);
    lines.push(`   ${r.description}${r.remarks !== "-" ? ` | ${r.remarks}` : ""}`);
  }
  if (nextOffset + session.pageSize < session.records.length) lines.push("", "Reply MORE for next 20.");
  else lines.push("", "End of history.");
  await sendWhatsAppText(from, lines.join("\n"));
  return true;
}

async function sendHistoryDateRange(from, area, fromDate, toDate, user, query = "") {
  const allRecords = searchMasterHistory(query, area);
  const filtered = allRecords
    .filter(record => historyDateMatches(record, fromDate, toDate))
    .sort((a, b) => {
      const ad = extractHistoryDates(a).filter(d => d >= fromDate && d <= toDate);
      const bd = extractHistoryDates(b).filter(d => d >= fromDate && d <= toDate);
      const aLast = ad.length ? Math.max(...ad.map(d => d.getTime())) : 0;
      const bLast = bd.length ? Math.max(...bd.map(d => d.getTime())) : 0;
      return bLast - aLast;
    });

  if (!filtered.length) {
    await sendWhatsAppText(
      from,
      `MAINTENANCE HISTORY – ${area}\n\n${formatHistoryDate(fromDate)} → ${formatHistoryDate(toDate)}\n\nNo maintenance history found for the selected date range.`
    );
    return true;
  }

  return await sendHistoryResults(from, area, filtered, user, {
    fromDate,
    toDate,
    queryLabel: query ? `Equipment filter: ${query}` : "ALL BDM EQUIPMENT"
  });
}


/* =========================================================
   PDF / TABLE OUTPUT
========================================================= */

function safePdfText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrapPlainText(value, maxChars = 82) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/*
 * AUTHENTICATED IDENTIFIER RULE
 * -----------------------------
 * Identifiers are never generated by the AI.  We only display an identifier
 * when it is explicitly present in the authorised source record, or when the
 * source record itself carries the canonical Equipment Master ID.
 */
function extractExplicitIdentifiers(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const equipmentNo = value.match(/(?:equipment\s*(?:no|number)|eqpmt\s*(?:no|number)|equipment\s*id)\s*[:#-]?\s*([A-Za-z0-9./_-]+)/i)?.[1] || null;
  const itemNo = value.match(/(?:item\s*(?:no|number)|item\s*id)\s*[:#-]?\s*([A-Za-z0-9./_-]+)/i)?.[1] || null;
  const sapNo = value.match(/(?:sap(?:\s*sub[- ]?equipment)?\s*(?:no|number|id))\s*[:#-]?\s*([A-Za-z0-9./_-]+)/i)?.[1] || null;
  const catNo = value.match(/(?:cat(?:alog)?\s*(?:no|number|id))\s*[:#-]?\s*([A-Za-z0-9./_-]+)/i)?.[1] || null;
  const drawingNo = value.match(/(?:drawing\s*(?:no|number|id))\s*[:#-]?\s*([A-Za-z0-9./_-]+)/i)?.[1] || null;
  return { equipmentNo, itemNo, sapNo, catNo, drawingNo };
}

function normalizeHistoryEquipmentToken(value) {
  return normalizeText(String(value || ""))
    .replace(/[–—]/g, "-")
    .replace(/\s*[-/]\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * BDM HISTORY EQUIPMENT MAPPING
 * -----------------------------
 * Equipment column = equipment only. Sub-equipment / part names stay inside
 * the job description. Specific names are used only when the source itself
 * identifies the equipment (e.g. CHARGING GRID-1, BP-1, WBF-1).
 *
 * IMPORTANT: this mapping does NOT invent Equipment No / Item No. Those are
 * shown only when the source record explicitly contains one.
 */
function canonicalHistoryEquipment(record) {
  const text = String(record?.text || "").replace(/\s+/g, " ").trim();
  const source = String(record?.source || "");
  const table = historySourceTable(source).toUpperCase();
  const upper = text.toUpperCase();

  // Prefer the source table's equipment family before scanning the job text.
  // This prevents a WBF/ECS reference mentioned inside a job description from
  // changing the parent equipment incorrectly.
  if (table === "WBF-1") return "WBF-1";
  if (table === "WBF-2") return "WBF-2";
  if (table === "ECS-1") return "ECS-1";
  if (table === "ECS-2") return "ECS-2";

  // Explicit equipment labels in other history sources.
  const wbf = upper.match(/\bWBF\s*[- ]\s*([12])\b/);
  if (wbf) return `WBF-${wbf[1]}`;
  const ecs = upper.match(/\bECS\s*[- ]\s*([12])\b/);
  if (ecs) return `ECS-${ecs[1]}`;

  // CH SIDE equipment history: preserve the actual numbered equipment.
  let m = upper.match(/\bCHARGING\s*GRID\s*[- ]?([123])\b/);
  if (m) return `CHARGING GRID-${m[1]}`;
  m = upper.match(/\b(?:CHAR\.?\s*GRID|CHARING\s*GRID)\s*[- ]?([123])\b/);
  if (m) return `CHARGING GRID-${m[1]}`;
  m = upper.match(/\bELEVATOR\s*[- ]?([12])\b/);
  if (m) return `ELEVATOR-${m[1]}`;
  m = upper.match(/\bLTP\s*[- ]?([12])\b/);
  if (m) return `LTP-${m[1]}`;
  m = upper.match(/\bBTD\s*[- ]?([12])\b/);
  if (m) return `BTD-${m[1]}`;
  m = upper.match(/\bBP\s*[- ]?([12])\b/);
  if (m) return `BP-${m[1]}`;

  // Source table establishes the equipment family where the row itself does
  // not contain a part-level label. Never put the part/sub-equipment in the
  // Equipment column.
  if (table === "CH SIDE EQPMT") {
    if (/F\/C\s*APPROACH\s*R\/?T|FURNACE\s*APPROACH\s*ROLLER\s*TABLE/.test(upper)) return "FART";
    if (/BSY\s*ROLLER\s*TABLE/.test(upper)) return "BSY RT";
    if (/BLOOM\s+TAKE\s+OFF\s+DEVICE/.test(upper)) return "BTD";
    if (/MAJOR\s+PROBLEMS\s+IN\s+CHARGING/.test(upper)) return "NA";
  }

  if (table === "CH GRIDS") {
    m = upper.match(/CHAR\.?\s*GRID\s*([123])\b/);
    if (m) return `CHARGING GRID-${m[1]}`;
    return "NA";
  }

  if (table === "BSY RT") return "BSY RT";
  if (table === "ELEVATORS") return m = upper.match(/ELEVATOR\s*[- ]?([12])/)
    ? `ELEVATOR-${m[1]}` : "NA";
  if (table === "LTP") return m = upper.match(/LTP\s*[- ]?([12])/)
    ? `LTP-${m[1]}` : "NA";
  if (table === "BTD") return m = upper.match(/BTD\s*[- ]?([12])/)
    ? `BTD-${m[1]}` : "NA";
  if (table === "BP") return m = upper.match(/BP\s*[- ]?([12])/)
    ? `BP-${m[1]}` : "NA";
  if (table === "FART" || table === "FART AMR") return "FART";

  if (["WHEEL", "PULLEY", "GBOX", "SPROCKET", "LINTEL", "SKIDS", "RECUIPRATOR", "CENTER SCREEN", "BRAKE"].includes(table)) {
    if (wbf) return `WBF-${wbf[1]}`;
    const wb = upper.match(/WALKING\s+BEAM\s+FURNACE\s*[- ]?([12])/);
    if (wb) return `WBF-${wb[1]}`;
    return "NA";
  }

  if (["TURBINE", "ECS PUMP", "ECS VALVES", "GAS LINE"].includes(table)) {
    if (ecs) return `ECS-${ecs[1]}`;
    return "NA";
  }

  return "NA";
}

function canonicalHistoryEquipmentFromRecords(records, index) {
  const record = records[index];
  const table = historySourceTable(String(record?.source || "")).toUpperCase();

  // BP source is a grouped sheet: "BP 1 | ..." starts a section and the
  // following rows belong to that BP until "BP 2 | ..." starts.
  if (table === "BP") {
    let current = null;
    for (let i = 0; i <= index; i++) {
      const text = String(records[i]?.text || "").replace(/\s+/g, " ").trim();
      const m = text.toUpperCase().match(/^BP\s*([12])\s*\|/);
      if (m) current = `BP-${m[1]}`;
    }
    return current || canonicalHistoryEquipment(record);
  }

  // CH GRIDS is also a grouped source: after CHAR. GRID 1/2/3, the following
  // date/part rows belong to that grid until the next grid heading appears.
  if (table === "CH GRIDS") {
    let current = null;
    for (let i = 0; i <= index; i++) {
      const text = String(records[i]?.text || "").replace(/\s+/g, " ").trim();
      const m = text.toUpperCase().match(/^CHAR\.?\s*GRID\s*([123])\b/);
      if (m) current = `CHARGING GRID-${m[1]}`;
    }
    return current || canonicalHistoryEquipment(record);
  }

  return canonicalHistoryEquipment(record);
}

function historyEquipmentMatchesQuery(record, query) {
  const q = normalizeHistoryEquipmentToken(query);
  if (!q) return true;
  const equipment = normalizeHistoryEquipmentToken(canonicalHistoryEquipment(record));
  const aliases = historyQueryAliases(q);
  return aliases.some(a => a === equipment || equipment.includes(a) || a.includes(equipment));
}

function historyExplicitIdentifier(text) {
  const ids = extractExplicitIdentifiers(text);
  return ids.equipmentNo || ids.itemNo || null;
}

function parseHistoryParts(record) {
  const text = String(record?.text || "").replace(/\s+/g, " ").trim();
  const parts = text.split("|").map(v => v.trim());
  const nonEmpty = parts.filter(Boolean);
  return { text, parts, nonEmpty };
}

function historyTableRows(records) {
  return records.map((x, index) => {
    const { text, parts, nonEmpty } = parseHistoryParts(x);
    const source = String(x.source || "History").replace(/\s+/g, " ").trim();
    const table = historySourceTable(source).toUpperCase();
    const dates = extractHistoryDates(x).map(formatHistoryDate);
    const date = dates.length ? dates.join(", ") : "-";
    const equipment = x.__historyEquipment || canonicalHistoryEquipmentFromRecords(records, index);
    let description = text || "-";
    let remarks = "-";
    let identifier = historyExplicitIdentifier(text);

    // Standard job-history sheets: preserve source column meaning.
    if (["WBF-1", "WBF-2", "BRAKE", "CENTER SCREEN", "GBOX", "LINTEL", "SPROCKET", "TURBINE"].includes(table)) {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const after = dateIndex >= 0 ? parts.slice(dateIndex + 1) : [];
      // WBF/WHEEL-style source rows are SNO | DATE | EQPT | JOB | REMARKS | TAG
      description = after[1] || after[0] || "-";
      remarks = after.slice(2).filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (["ECS-1", "ECS-2"].includes(table)) {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const after = dateIndex >= 0 ? parts.slice(dateIndex + 1) : [];
      // ECS rows use SNO | DATE | EQPT | JOB | REMARKS | TAG.
      description = after[1] || after[0] || "-";
      remarks = after.slice(2).filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (["ECS PUMP", "ECS VALVES"].includes(table)) {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const before = dateIndex >= 0 ? parts.slice(0, dateIndex) : parts.slice();
      const after = dateIndex >= 0 ? parts.slice(dateIndex + 1) : [];
      // These sources use SNO | EQPT | JOB | DATE | REMARKS | TAG.
      description = before[2] || before[1] || "-";
      remarks = after.filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (table === "GAS LINE") {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const before = dateIndex >= 0 ? parts.slice(0, dateIndex) : parts.slice();
      description = before[2] || before[1] || "-";
      remarks = before.slice(3).filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (["WHEEL", "PULLEY", "RECUIPRATOR", "SKIDS"].includes(table)) {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const before = dateIndex >= 0 ? parts.slice(0, dateIndex) : parts.slice();
      const after = dateIndex >= 0 ? parts.slice(dateIndex + 1) : [];
      if (before.length && /^\d+$/.test(before[0])) before.shift();
      description = before.slice(1).join(" | ") || "-";
      remarks = after.filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (table === "CH SIDE EQPMT") {
      const dateIndex = parts.findIndex(v => parseHistoryDate(v));
      const after = dateIndex >= 0 ? parts.slice(dateIndex + 1) : [];
      const before = dateIndex >= 0 ? parts.slice(0, dateIndex) : parts.slice();
      if (before.length && /^\d+$/.test(before[0])) before.shift();
      description = before.slice(1).join(" | ") || after[0] || before.join(" | ") || "-";
      remarks = after.slice(1).filter(v => !parseHistoryDate(v)).join(" | ") || "-";
    } else if (["ELEVATORS", "BTD", "LTP", "BP"].includes(table)) {
      // These sheets are grouped equipment/sub-equipment history tables.
      // Keep the complete source row as description; never promote SUB/PART
      // values into the Equipment column.
      description = nonEmpty.filter(v => !parseHistoryDate(v)).join(" | ") || "Source record";
    } else if (table === "CH GRIDS") {
      description = nonEmpty.filter(v => !/^CHAR\.?\s*GRID\s*[123]$/i.test(v)).join(" | ") || "Source record";
    } else if (table === "BSY RT") {
      description = nonEmpty.filter(v => !/^\d+$/.test(v) && !parseHistoryDate(v)).join(" | ") || "Source record";
    } else if (table === "FART" || table === "FART AMR") {
      description = nonEmpty.filter(v => !/^\d+$/.test(v) && !parseHistoryDate(v)).join(" | ") || "Source record";
    } else {
      description = nonEmpty.filter(v => !parseHistoryDate(v)).join(" | ") || "Source record";
    }


    // Explicit identifiers only. No source number => NA.
    if (!identifier) identifier = null;

    return {
      no: index + 1,
      equipmentNo: identifier,
      itemNo: null,
      sapNo: null,
      catNo: null,
      drawingNo: null,
      equipment,
      date,
      description,
      action: "-",
      remarks,
      inspectedBy: x.inspectedBy || x.inspected_by || null,
      solvedBy: x.solvedBy || x.solved_by || null,
      source
    };
  });
}


function buildHistoryTableText(records) {
  const rows = historyTableRows(records);
  const out = [
    "MAINTENANCE HISTORY",
    "",
    "S.No | Equipment No | Equipment / Item | Date       | Description / Action",
    "─────┼──────────────┼──────────────────┼────────────┼────────────────────────"
  ];
  for (const r of rows) {
    const exactNo = r.equipmentNo || r.itemNo || r.sapNo || "NA";
    const desc = `${r.description}${r.action && r.action !== "-" ? ` | ${r.action}` : ""}`;
    out.push(`${String(r.no).padEnd(4)} | ${String(exactNo).slice(0,12).padEnd(12)} | ${String(r.equipment).slice(0,16).padEnd(16)} | ${String(r.date).padEnd(10)} | ${desc.slice(0,48)}`);
  }
  out.push("", `Showing ${rows.length} record(s).`);
  out.push("Identifier rule: numbers shown only from authorised source records; no AI-generated numbering.");
  return out.join("\n");
}

function buildHistoryTablePdf(title, fromDate, toDate, records) {
  const rows = historyTableRows(records);
  // A4 PORTRAIT — printable maintenance-history register.
  const pageWidth = 595;
  const pageHeight = 842;
  const left = 18;
  const right = 18;
  const top = 805;
  const bottom = 34;
  const headerH = 34;
  const lineH = 8;
  const fontSize = 5.6;

  // Source column intentionally removed. Inspector/Solver are shown only when
  // present in source data; otherwise NA. No identifiers are invented.
  const columns = [
    ["S.No", 25],
    ["Equipment No / Item No", 68],
    ["Equipment", 68],
    ["Date", 55],
    ["Job Description / Action", 160],
    ["Remarks", 88],
    ["Inspected By", 47],
    ["Solved By", 48]
  ];

  const usableWidth = pageWidth - left - right;
  const totalWidth = columns.reduce((a, c) => a + c[1], 0);
  const scale = usableWidth / totalWidth;
  columns.forEach(c => c[1] = Math.floor(c[1] * scale));
  columns[columns.length - 1][1] += usableWidth - columns.reduce((a, c) => a + c[1], 0);

  function wrap(text, chars) {
    const value = String(text ?? "NA").trim() || "NA";
    const words = value.split(/\s+/).filter(Boolean);
    const out = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > chars && line) { out.push(line); line = word; }
      else line = next;
    }
    if (line || !out.length) out.push(line || "NA");
    return out;
  }

  function rowLines(r) {
    const exactId = r.equipmentNo || r.itemNo || r.sapNo || "NA";
    const job = [r.description, r.action !== "-" ? r.action : ""].filter(Boolean).join(" | ") || "NA";
    const vals = [r.no, exactId, r.equipment || "NA", r.date || "NA", job, r.remarks || "NA", r.inspectedBy || "NA", r.solvedBy || "NA"];
    return vals.map((v, i) => wrap(v, Math.max(7, Math.floor(columns[i][1] / 3.0))));
  }

  const pages = [];
  let pageRows = [];
  let used = headerH + 22;
  const maxBody = top - bottom;
  for (const r of rows) {
    const cells = rowLines(r);
    const h = Math.max(...cells.map(x => x.length)) * lineH + 7;
    if (used + h > maxBody && pageRows.length) {
      pages.push(pageRows); pageRows = []; used = headerH;
    }
    pageRows.push({ r, cells, h }); used += h;
  }
  if (pageRows.length || !pages.length) pages.push(pageRows);

  const objects = [];
  const fontRegular = objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageObjectNumbers = [];

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const content = [];
    let y = top;
    if (pageIndex === 0) {
      content.push(`BT /F2 13 Tf ${left} ${y} Td (${safePdfText(title)}) Tj ET`); y -= 16;
      const period = `${fromDate && toDate ? `Period: ${formatHistoryDate(fromDate)} to ${formatHistoryDate(toDate)}` : "Period: All available records"} | Total Records: ${rows.length}`;
      content.push(`BT /F1 7.5 Tf ${left} ${y} Td (${safePdfText(period)}) Tj ET`); y -= 18;
    }

    let x = left;
    columns.forEach(([label, width]) => {
      content.push(`q 0.75 G ${x} ${y-headerH+4} ${width} ${headerH} re S Q`);
      const headerLines = wrap(label, Math.max(7, Math.floor(width / 3.1)));
      let hy = y - 10;
      for (const line of headerLines.slice(0, 3)) {
        content.push(`BT /F2 5.5 Tf ${x+2} ${hy} Td (${safePdfText(line)}) Tj ET`); hy -= 7;
      }
      x += width;
    });
    y -= headerH;

    for (const item of pages[pageIndex]) {
      let x0 = left;
      const rowY = y - item.h;
      for (let i = 0; i < columns.length; i++) {
        const width = columns[i][1];
        content.push(`q 0.8 G ${x0} ${rowY} ${width} ${item.h} re S Q`);
        let ly = y - 9;
        for (const line of item.cells[i]) {
          content.push(`BT /F1 ${fontSize} Tf ${x0+2} ${ly} Td (${safePdfText(line)}) Tj ET`);
          ly -= lineH;
        }
        x0 += width;
      }
      y = rowY;
    }

    const stream = content.join("\n");
    const contentObject = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const pageObject = objects.length + 1;
    objects.push(`<< /Type /Page /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    pageObjectNumbers.push(pageObject);
  }

  const pagesObject = objects.length + 1;
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map(n => `${n} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`);
  const catalogObject = objects.length + 1;
  objects.push(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);
  for (const pageNo of pageObjectNumbers) {
    const idx = pageNo - 1;
    objects[idx] = objects[idx].replace("/Type /Page", `/Type /Page /Parent ${pagesObject} 0 R`);
  }

  let pdf = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function buildSimplePdf(title, records) {
  const rows = historyTableRows(records);
  const pageWidth = 595;
  const pageHeight = 842;
  const left = 42;
  const top = 800;
  const bottom = 48;
  const fontSize = 9;
  const leading = 13;
  const maxLinesPerPage = Math.floor((top - bottom) / leading);

  const allLines = [
    { text: title, size: 15, bold: true },
    { text: `Generated: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, size: 9, bold: false }
  ];

  for (const r of rows) {
    allLines.push({ text: "", size: 9, bold: false });
    const exactNo = r.equipmentNo || r.itemNo || r.sapNo || "Not available in source";
    allLines.push({ text: `${r.no}. ${exactNo} | ${r.equipment} | ${r.date}`, size: 9, bold: true });
    allLines.push({ text: `Description: ${r.description}`, size: 9, bold: false });
    allLines.push({ text: `Action: ${r.action}`, size: 9, bold: false });
    if (r.remarks !== "-") allLines.push({ text: `Remarks: ${r.remarks}`, size: 9, bold: false });
    allLines.push({ text: `Source: ${r.source}`, size: 9, bold: false });
  }

  const pages = [];
  let current = [];
  let lineCount = 0;
  for (const item of allLines) {
    const wrapped = wrapPlainText(item.text, 92);
    for (const line of wrapped) {
      if (lineCount >= maxLinesPerPage) {
        pages.push(current);
        current = [];
        lineCount = 0;
      }
      current.push({ ...item, text: line });
      lineCount++;
    }
  }
  if (current.length) pages.push(current);

  const objects = [];
  const pageObjectNumbers = [];
  const fontRegular = objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  for (const pageLines of pages) {
    let y = top;
    const content = [];
    for (const item of pageLines) {
      content.push(`BT /F${item.bold ? 2 : 1} ${item.size} Tf ${left} ${y} Td (${safePdfText(item.text)}) Tj ET`);
      y -= leading;
    }
    const stream = content.join("\n");
    const contentObject = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    const pageObject = objects.length + 1;
    objects.push(`<< /Type /Page /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    pageObjectNumbers.push(pageObject);
  }

  const pagesObject = objects.length + 1;
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map(n => `${n} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`);
  const catalogObject = objects.length + 1;
  objects.push(`<< /Type /Catalog /Pages ${pagesObject} 0 R >>`);

  // Patch each page object with its parent after all object numbers are known.
  for (let i = 0; i < pageObjectNumbers.length; i++) {
    const idx = pageObjectNumbers[i] - 1;
    objects[idx] = objects[idx].replace("/Type /Page", `/Type /Page /Parent ${pagesObject} 0 R`);
  }

  let pdf = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

async function uploadWhatsAppPdf(to, pdfBuffer, filename, caption) {
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), filename);

    const uploadResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        body: form
      }
    );
    const uploadData = await uploadResponse.json();
    if (!uploadResponse.ok || !uploadData.id) {
      console.error("[WHATSAPP] PDF upload error:", uploadData);
      return false;
    }

    const sendResponse = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "document",
          document: {
            id: uploadData.id,
            caption,
            filename
          }
        })
      }
    );
    const sendData = await sendResponse.json();
    if (!sendResponse.ok) {
      console.error("[WHATSAPP] PDF send error:", sendData);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[WHATSAPP] PDF generation/send error:", error);
    return false;
  }
}

async function processMasterDataQuery(from, text, user) {
  const value = String(text || "").trim();
  const lower = normalizeText(value);
  if (!MASTER_DATA) return false;

  if (/^more$/i.test(value) && historyPageSessions.has(from)) {
    return await sendNextHistoryPage(from);
  }

  // Date-range history flow always takes priority over generic text handling.
  if (historySessions.has(from)) {
    return await processHistoryDateSession(from, value, user);
  }

  const looksLikeQuery = /\b(history|historical|records?|defects?|spares?|equipment|sub[- ]?equipment|smp|sop|troubleshoot|knowledge)\b/i.test(value);
  if (!looksLikeQuery) return false;

  const requestedArea = detectRequestedArea(value);

  // Backend scope gate: requested area must be inside the user's scope.
  if (requestedArea && !scopeAreaMatches(user, requestedArea)) {
    await sendWhatsAppText(from, "Access restricted.");
    return true;
  }

  if (/\b(history|historical|records?)\b/i.test(value)) {
    const area = requestedArea || user.area_of_working;

    if (!area) {
      await sendWhatsAppText(from, "Area confirm cheyyandi.");
      return true;
    }

    // A plain "BDM history" means the complete BDM history across all
    // authorised BDM equipment. A specific equipment name filters only that
    // equipment. Date range remains available through option 10 or by
    // explicitly sending two dates.
    const cleanedQuery = value
      .replace(/\b(history|historical|records?|show|give|tell|please|all|jobs?|bdm)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const dateMatches = [...value.matchAll(/\b(?:\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})\b/g)]
      .map(m => parseHistoryDate(m[0])).filter(Boolean);

    if (dateMatches.length >= 2) {
      const fromDate = dateMatches[0] <= dateMatches[1] ? dateMatches[0] : dateMatches[1];
      const toDate = dateMatches[0] <= dateMatches[1] ? dateMatches[1] : dateMatches[0];
      return await sendHistoryDateRange(from, area, fromDate, toDate, user, cleanedQuery);
    }

    const records = searchMasterHistory(cleanedQuery, area);
    if (!records.length) {
      await sendWhatsAppText(from, cleanedQuery ? "Equipment/history match ledu." : "Maintenance history data ledu / confirm cheyyalenu.");
      return true;
    }

    return await sendHistoryResults(from, area, records, user, {
      queryLabel: cleanedQuery ? `Equipment filter: ${cleanedQuery}` : "ALL BDM EQUIPMENT"
    });
  }

  if (/\b(defects?|failure|failures)\b/i.test(value)) {
    if (!Array.isArray(MASTER_DATA.defects)) {
      await sendWhatsAppText(from, "Data ledu / confirm cheyyalenu.");
      return true;
    }
    let rows = MASTER_DATA.defects;
    if (requestedArea) {
      rows = rows.filter(x => cleanScopeValue(x.area) === cleanScopeValue(requestedArea));
    } else if (!isSuperAdmin(from)) {
      rows = rows.filter(x => cleanScopeValue(x.area) === cleanScopeValue(user.area_of_working));
    }
    const q = normalizeText(value).replace(/\b(?:defects?|failure|failures|show|give|find|please)\b/g, " ").trim();
    if (q) rows = rows.filter(x => normalizeText(`${x.eq || ""} ${x.subeq || ""} ${x.description || ""} ${x.category || ""}`).includes(q));
    rows = rows.slice(0, 12);
    if (!rows.length) {
      await sendWhatsAppText(from, "Defect match ledu.");
      return true;
    }
    const lines = ["DEFECTS", "", "S.No | Equipment No | Sub-equipment | Date       | Description"];
    rows.forEach((x, i) => lines.push(`${i + 1}. ${x.eq || "—"} | ${x.subeq || "—"} | ${x.date || "—"} | ${String(x.description || "—").slice(0, 90)}`));
    lines.push("", "Identifiers are copied exactly from the authorised defect source.");
    await sendWhatsAppText(from, lines.join("\n").slice(0, 4000));
    return true;
  }

  if (/\b(spares?|parts?|cat(?:alog)?|drawing)\b/i.test(value)) {
    if (!Array.isArray(MASTER_DATA.spares)) {
      await sendWhatsAppText(from, "Data ledu / confirm cheyyalenu.");
      return true;
    }
    let rows = MASTER_DATA.spares;
    if (!isSuperAdmin(from)) {
      const area = cleanScopeValue(user.area_of_working);
      const allowedEquipmentIds = new Set((MASTER_DATA.equipment || []).filter(x => cleanScopeValue(x.area) === area).map(x => String(x.id || "")));
      rows = rows.filter(x => allowedEquipmentIds.has(String(x.equipment || "")));
    }
    const q = normalizeText(value).replace(/\b(?:spares?|parts?|cat(?:alog)?|drawing|show|give|find|please)\b/g, " ").trim();
    if (q) rows = rows.filter(x => normalizeText(`${x.equipment || ""} ${x.part || ""} ${x.cat || ""} ${x.drawing || ""}`).includes(q));
    rows = rows.slice(0, 12);
    if (!rows.length) {
      await sendWhatsAppText(from, "Spare match ledu.");
      return true;
    }
    const lines = ["SPARE PARTS", "", "S.No | Equipment No | Part | CAT No | Drawing No | Stock"];
    rows.forEach((x, i) => lines.push(`${i + 1}. ${x.equipment || "—"} | ${String(x.part || "—").slice(0, 45)} | ${x.cat || "—"} | ${x.drawing || "—"} | ${x.stock || "—"}`));
    lines.push("", "Identifiers are copied exactly from the authorised spare source.");
    await sendWhatsAppText(from, lines.join("\n").slice(0, 4000));
    return true;
  }

  if (/\b(equipment|sub[- ]?equipment)\b/i.test(value)) {
    if (!Array.isArray(MASTER_DATA.equipment)) {
      await sendWhatsAppText(from, "Data ledu / confirm cheyyalenu.");
      return true;
    }

    const requested = normalizeText(value)
      .replace(/\b(?:equipment|sub[- ]?equipment|number|no|id|search|find|show|give|please)\b/g, " ")
      .replace(/\b(?:bdm|bar\s*mill|barmill|finishing|hydraulics|cranes?|auxiliary)\b/g, " ")
      .trim();
    const exactId = value.match(/(?:equipment\s*(?:no|number|id)?|eqpmt\s*(?:no|number|id)?)\s*[:#-]?\s*(\d+)\b/i)?.[1] || null;

    let rows = MASTER_DATA.equipment;
    if (requestedArea) {
      rows = rows.filter(x => cleanScopeValue(x.area) === cleanScopeValue(requestedArea));
    } else {
      rows = rows.filter(x => cleanScopeValue(x.area) === cleanScopeValue(user.area_of_working));
    }

    if (exactId) {
      rows = rows.filter(x => String(x.id || "") === exactId);
    } else if (requested) {
      rows = rows.filter(x => normalizeText(`${x.id || ""} ${x.name || ""} ${x.location || ""} ${x.sub_area || ""}`).includes(requested));
    }

    if (!rows.length) {
      await sendWhatsAppText(from, "Equipment match ledu.");
      return true;
    }

    const lines = ["EQUIPMENT MASTER", ""];
    rows.slice(0, 12).forEach((x, i) => {
      // x.id is the canonical identifier carried by the authorised Equipment Master JSON.
      lines.push(`${i + 1}. ${x.id || "Not available in authorised master"} – ${x.name || "-"}`);
      lines.push(`Area: ${x.area || "-"}`);
      lines.push(`Sub-area: ${x.sub_area || "-"}`);
      lines.push(`Location: ${x.location || "-"}`);
    });
    await sendWhatsAppText(from, lines.join("\n").slice(0, 4000));
    return true;
  }

  return false;
}

/* =========================================================
   MAINTENANCE FIELD
========================================================= */

async function saveMaintenanceSubmission({
  messageId,
  from,
  user,
  messageType,
  textContent = null,
  caption = null,
  mediaId = null,
  mimeType = null,
  fileName = null
}) {
  const result = await pool.query(
    `
    INSERT INTO maintenance_submissions
      (message_id, whatsapp_number, employee_number, message_type,
       text_content, caption, media_id, mime_type, file_name,
       user_area, user_section)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
    `,
    [
      messageId || null,
      from,
      user.employee_number || null,
      messageType,
      textContent,
      caption,
      mediaId,
      mimeType,
      fileName,
      user.area_of_working || null,
      user.section_department || null
    ]
  );

  return result.rowCount > 0;
}

async function processMaintenanceField(from, text, user, context = {}) {
  const value = String(text || "").trim();
  const n = Number(value);

  const names = {
    1: "Log Book",
    2: "Breakdown / Delay Management",
    3: "Defect Management",
    4: "Maintenance Jobs / Work Orders",
    5: "Preventive Maintenance (PM)",
    6: "Inspection & Condition Monitoring",
    7: "CBM / Vibration Monitoring",
    8: "Equipment Master",
    9: "SAP Sub-Equipment",
    10: "Maintenance History",
    11: "Spare Parts Management",
    12: "Drawings & Technical Documents",
    13: "SMP / Standard Maintenance Procedure",
    14: "SOP / Standard Operating Procedure",
    15: "Troubleshooting & Failure Analysis",
    16: "RCM / Reliability Management",
    17: "Shutdown Maintenance",
    18: "Employee Attendance",
    19: "Contract Worker Attendance",
    20: "Manpower / Labour Management"
  };

  // Numeric 10 opens the History date-range workflow.
  if (n === 10 && /^10$/.test(value)) {
    if (!hasPermission(user, "view")) {
      await sendWhatsAppText(from, "Access restricted.");
      return;
    }
    startHistoryDateSession(from, user.area_of_working || "BDM");
    await sendWhatsAppText(from, historyDatePrompt(historySessions.get(from)));
    return;
  }

  // Numeric input remains available as an optional shortcut.
  if (/^\d+$/.test(value) && names[n]) {
    const permissionByModule = {
      1: "logbook_entry",
      2: "data_entry",
      3: "data_entry",
      4: "jobs_entry",
      5: "data_entry",
      6: "data_entry",
      7: "vibration_readings_entry",
      8: "view",
      9: "view",
      10: "view",
      11: "view",
      12: "view",
      13: "smp_sop_troubleshooting",
      14: "smp_sop_troubleshooting",
      15: "smp_sop_troubleshooting",
      16: "analysis_reports",
      17: "shutdown_jobs_entry",
      18: "attendance_manpower",
      19: "attendance_manpower",
      20: "attendance_manpower"
    };

    const requiredPermission = permissionByModule[n];
    if (requiredPermission && !hasPermission(user, requiredPermission)) {
      await sendWhatsAppText(from, "Access restricted.");
      return;
    }

    await sendWhatsAppText(
      from,
      `Selected: ${names[n]}\n\n` +
      `Send the maintenance details directly.\n` +
      `Text, voice, image or document are supported.`
    );
    return;
  }

  // Handle natural-language data retrieval before treating text as a new submission.
  if (await processMasterDataQuery(from, value, user)) {
    return;
  }

  const saved = await saveMaintenanceSubmission({
    messageId: context.messageId,
    from,
    user,
    messageType: context.messageType || "text",
    textContent: value || null,
    caption: context.caption || null,
    mediaId: context.mediaId || null,
    mimeType: context.mimeType || null,
    fileName: context.fileName || null
  });

  if (!saved && context.messageId) {
    // Webhook retry / duplicate message: no second acknowledgement.
    return;
  }

  await sendWhatsAppText(
    from,
    getShortMaintenanceAck(value)
  );
}

/* =========================================================
   INCOMING MESSAGE
========================================================= */

async function processIncomingMessage(message) {
  if (!message) return;

  const from = String(message.from || "").replace(/\D/g, "");

  if (!from) return;

  let text = "";
  let interactiveAction = "";

  if (message.type === "text") {
    text = message.text?.body?.trim() || "";
  } else if (message.type === "interactive") {
    interactiveAction =
      message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.id ||
      "";
  } else if (["image", "document", "audio", "video", "sticker"].includes(message.type)) {
    const media = message[message.type] || {};
    text = media.caption?.trim() || "";
  } else {
    return;
  }

  console.log("[INCOMING]", from, text || interactiveAction);

  // WhatsApp may retry webhook deliveries. Process each message only once.
  const messageId = String(message.id || "").trim();
  if (messageId) {
    const seen = await pool.query(
      `INSERT INTO processed_messages (message_id, whatsapp_number, message_type)
       VALUES ($1,$2,$3)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [messageId, from, message.type]
    );
    if (!seen.rowCount) return;
  }

  if (interactiveAction) {
    /*
      1. User management
    */
    if (await startUserEdit(from, interactiveAction)) {
      return;
    }

    /*
      2. Additional authorities — only after approval
    */
    if (await processAuthorityAction(from, interactiveAction)) {
      return;
    }

    /*
      3. Approval buttons
    */
    const approvalMatch = interactiveAction.match(
      /^(approve|reject)_(\d+)$/i
    );

    if (approvalMatch) {
      const action = approvalMatch[1].toLowerCase();
      const employeeNumber = approvalMatch[2];

      await processApprovalAction(
        from,
        action,
        employeeNumber
      );

      return;
    }
  }

  /*
    Text approval commands are retained as a backup.
  */
  if (text && await processApprovalCommand(from, text)) {
    return;
  }

  /*
    Super Admin user-field edit flow.
  */
  if (text && await processAdminEditText(from, text)) {
    return;
  }

  const authorityDetailsMatch =
    text && text.match(/^AUTHORITY\s+(\d+)$/i);

  if (authorityDetailsMatch) {
    const employeeNumber = authorityDetailsMatch[1];
    const allowed = await canGrantAuthority(from, employeeNumber);
    if (!allowed) {
      await sendWhatsAppText(from, "Access restricted.");
      return;
    }
    await sendAuthorityDetails(from, employeeNumber);
    return;
  }

  if (text && /^(AUTHORITY LIST|ALL AUTHORITIES|USER AUTHORITIES)$/i.test(text)) {
    const actorResult = await pool.query(
      `SELECT * FROM users WHERE whatsapp_number=$1 AND approval_status='approved'`,
      [from]
    );
    const actor = actorResult.rows[0];
    if (!isSuperAdmin(from) && !(actor && isScopeAuthorityManager(actor, from))) {
      await sendWhatsAppText(from, "Access restricted.");
      return;
    }
    await sendAllAuthorityDetails(from);
    return;
  }

  const manageMatch =
    text && text.match(/^MANAGE USER\s+(\d+)$/i);

  if (manageMatch && isSuperAdmin(from)) {
    await sendUserManagementMenu(from, manageMatch[1]);
    return;
  }

  /*
    Reset must be checked before normal registration handling.
  */
  if (isResetCommand(text)) {
    await resetRegistration(from);
    return;
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1`,
    [from]
  );

  const user = result.rows[0];

  if (!user) {
    await processRegistration(from, text);
    return;
  }

  const incomplete =
    !user.name ||
    !user.employee_number ||
    !user.designation ||
    !user.area_of_working ||
    !user.section_department;

  if (incomplete) {
    await processRegistration(from, text);
    return;
  }

  if (user.approval_status === "pending") {
    await sendWhatsAppText(
      from,
      "Submitted ✓\nPending Approval ⏳"
    );
    return;
  }

  if (user.approval_status === "rejected") {
    await sendWhatsAppText(
      from,
      'Rejected ❌\nSend "RESET REGISTRATION" to correct details.'
    );
    return;
  }

  if (user.approval_status === "approved") {
    if (isGreeting(text)) {
      await sendWhatsAppText(from, `Approved ✓\nSend maintenance details directly.`);
      return;
    }

    // Search the imported LMMM master data BEFORE falling back to generic
    // maintenance submission. This ensures queries such as "BDM history"
    // are answered from source data instead of being saved as a new entry.
    if (message.type === "text") {
      const handledByMasterData = await processMasterDataQuery(from, text, user);
      if (handledByMasterData) return;
    }

    const media = message[message.type] || {};

    // No permission list is shown to the user.
    await processMaintenanceField(from, text, user, {
      messageId,
      messageType: message.type,
      caption: media.caption || null,
      mediaId: media.id || null,
      mimeType: media.mime_type || null,
      fileName: media.filename || null
    });
    return;
  }

  await sendWhatsAppText(
    from,
    "Your account is not currently authorised. Please contact the authorised administrator."
  );
}

/* =========================================================
   WEBHOOK
========================================================= */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token =
    String(req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verification successful");
    return res.status(200).send(challenge);
  }

  console.log("[WEBHOOK] Verification failed");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];

        for (const message of messages) {
          try {
            await processIncomingMessage(message);
          } catch (error) {
            console.error(
              "[MESSAGE PROCESSING ERROR]",
              error
            );
          }
        }
      }
    }
  } catch (error) {
    console.error("[WEBHOOK ERROR]", error);
  }
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "LMMM Mechanical Maintenance AI Agent",
    status: "live"
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    database_configured: Boolean(process.env.DATABASE_URL),
    whatsapp_configured: Boolean(
      PHONE_NUMBER_ID && ACCESS_TOKEN
    ),
    ai_configured: Boolean(process.env.OPENAI_API_KEY),
    owner_approval_configured: OWNER_NUMBERS.size > 0,
    master_data_loaded: MASTER_DATA_STATUS.loaded,
    master_data_records: MASTER_DATA_STATUS.records
  });
});

/* =========================================================
   START
========================================================= */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `LMMM AI Maintenance Agent listening on ${PORT}`
      );

      // Load the large JSON after the port is bound so Render health checks
      // are not delayed by file I/O or JSON parsing.
      loadMasterData().catch(error => {
        console.error("[MASTER DATA] Unexpected load error:", error);
      });
    });
  } catch (error) {
    console.error("[STARTUP ERROR]", error);
    process.exit(1);
  }
}

startServer();
