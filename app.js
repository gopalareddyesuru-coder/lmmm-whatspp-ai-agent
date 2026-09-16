import "dotenv/config";
import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;

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
  const maintenanceColumns = [
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
   AUTHORITY MANAGEMENT
========================================================= */

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
    if (!isSuperAdmin(from)) {
      await sendWhatsAppText(from, "This information is available only to Super Admin.");
      return true;
    }
    await sendAuthorityDetails(from, detailsMatch[1]);
    return true;
  }

  const allUsersMatch = actionId.match(/^authority_all_users_(\\d+)$/i);
  if (allUsersMatch) {
    if (!isSuperAdmin(from)) {
      await sendWhatsAppText(from, "This information is available only to Super Admin.");
      return true;
    }
    await sendAllAuthorityDetails(from);
    return true;
  }

  const match = actionId.match(
    /^authority_(print_export|master_modify|analysis_reports|smp_sop_troubleshooting|attendance_manpower|maintenance_modules|full_access)_(\d+)$/i
  );

  if (!match) return false;

  if (!isSuperAdmin(from)) {
    await sendWhatsAppText(
      from,
      "Not authorised."
    );
    return true;
  }

  const permission = match[1].toLowerCase();
  const employeeNumber = match[2];

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
  if (!isSuperAdmin(to)) {
    await sendWhatsAppText(to, "This information is available only to Super Admin.");
    return true;
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(to, `No user found for Employee Number ${employeeNumber}.`);
    return true;
  }

  const user = result.rows[0];
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
  if (!isSuperAdmin(to)) {
    await sendWhatsAppText(to, "This information is available only to Super Admin.");
    return true;
  }

  const result = await pool.query(
    `SELECT name, employee_number, designation, area_of_working,
            section_department, approval_status, permissions
     FROM users
     WHERE employee_number IS NOT NULL
     ORDER BY employee_number`
  );

  if (!result.rowCount) {
    await sendWhatsAppText(to, "No registered users found.");
    return true;
  }

  const lines = ["ALL USER AUTHORITIES", ""];

  for (const user of result.rows) {
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
       text_content, caption, media_id, mime_type, file_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
      fileName
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

  // Numeric input remains available as an optional shortcut.
  if (/^\d+$/.test(value) && names[n]) {
    await sendWhatsAppText(
      from,
      `Selected: ${names[n]}\n\n` +
      `Send the maintenance details directly.\n` +
      `Text, voice, image or document are supported.`
    );
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

  if (authorityDetailsMatch && isSuperAdmin(from)) {
    await sendAuthorityDetails(from, authorityDetailsMatch[1]);
    return;
  }

  if (text && /^(AUTHORITY LIST|ALL AUTHORITIES|USER AUTHORITIES)$/i.test(text) && isSuperAdmin(from)) {
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
      await sendWhatsAppText(from, `Approved ✓\nSend maintenance details directly.`);;
      return;
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
    owner_approval_configured: OWNER_NUMBERS.size > 0
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
    });
  } catch (error) {
    console.error("[STARTUP ERROR]", error);
    process.exit(1);
  }
}

startServer();
