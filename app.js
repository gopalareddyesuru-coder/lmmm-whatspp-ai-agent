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

  /* Required for Super Admin user-edit workflow.
     Created during startup, not during the first edit request. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_edit_sessions (
      whatsapp_number VARCHAR(20) PRIMARY KEY,
      employee_number VARCHAR(50) NOT NULL,
      field_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("[DATABASE] All required tables ready");
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
  (
    process.env.SUPER_ADMIN_NUMBERS ||
    process.env.OWNER_WHATSAPP_NUMBERS ||
    ""
  )
    .split(",")
    .map(x => x.replace(/\D/g, ""))
    .filter(Boolean)
);

/* =========================================================
   MESSAGES
========================================================= */

const REGISTRATION_MESSAGE = `
Welcome to LMMM Maintenance AI Agent 👋

You can register in ONE message.

Please send:
• Name
• Employee Number
• Designation
• Area of Working
• Section / Department

Example:
Gopala Reddy E
123125
Manager
Bar Mill
Mechanical

I will understand the details and submit them for approval.
`.trim();

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
   WHATSAPP SEND
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
    console.error("[WHATSAPP] Send error:", data);
  }

  return data;
}

async function sendInteractive(to, interactive) {
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
        interactive
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("[WHATSAPP] Interactive send error:", data);
  }

  return data;
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

  if (
    /^bdm$|^breakdown\s*mill$|^break\s*down\s*mill$|^breakdown\s*mill\s*mechanical$/.test(v)
  ) {
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

function isOwner(number) {
  return OWNER_NUMBERS.has(String(number || "").replace(/\D/g, ""));
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
    if (!result.area_of_working) {
      result.area_of_working = normalizeArea(lines[3]);
    }

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
   REGISTRATION / APPROVAL
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
      `I could not identify these required details:\n\n${missing
        .map(x => `• ${x}`)
        .join("\n")}\n\nPlease send all 5 details in one message.`
    );
    return;
  }

  if (!/^\d+$/.test(String(data.employee_number))) {
    await sendWhatsAppText(
      from,
      "Employee Number must contain numbers only. Please correct it and send the registration details again."
    );
    return;
  }

  try {
    const duplicate = await pool.query(
      `SELECT whatsapp_number FROM users
       WHERE employee_number=$1 AND whatsapp_number<>$2`,
      [data.employee_number, from]
    );

    if (duplicate.rowCount > 0) {
      await sendWhatsAppText(
        from,
        "This Employee Number is already registered with another WhatsApp number. Please contact the authorised administrator."
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
      VALUES ($1,$2,$3,$4,$5,$6,'pending','pending','[]'::jsonb,CURRENT_TIMESTAMP)
      ON CONFLICT (whatsapp_number)
      DO UPDATE SET
        name=EXCLUDED.name,
        employee_number=EXCLUDED.employee_number,
        designation=EXCLUDED.designation,
        area_of_working=EXCLUDED.area_of_working,
        section_department=EXCLUDED.section_department,
        system_role='pending',
        approval_status='pending',
        updated_at=CURRENT_TIMESTAMP
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
      "Registration submitted successfully.\n*Status: Pending Approval ⏳*"
    );

    await notifyOwners(data, from);
  } catch (error) {
    console.error("[REGISTRATION] Submit error:", error);

    if (error.code === "23505") {
      await sendWhatsAppText(
        from,
        "Employee Number already exists. Please verify the number or contact the authorised administrator."
      );
      return;
    }

    await sendWhatsAppText(
      from,
      "Unable to save the registration right now. Please try again."
    );
  }
}

async function notifyOwners(data, from) {
  if (!OWNER_NUMBERS.size) {
    console.log("[APPROVAL] Super Admin number is not configured.");
    return;
  }

  const message = `
🔔 NEW LMMM REGISTRATION

Name: ${data.name}
Employee No: ${data.employee_number}
Designation: ${data.designation}
Area: ${data.area_of_working}
Section: ${data.section_department}
WhatsApp: ${from}

Status: PENDING APPROVAL
`.trim();

  for (const owner of OWNER_NUMBERS) {
    await sendWhatsAppText(owner, message);
    await sendAuthorityAssignmentMenu(owner, data.employee_number, []);
  }
}

/* =========================================================
   AUTHORITY ASSIGNMENT
   WhatsApp does not provide native multi-checkboxes here.
   This uses toggle rows: selecting a row adds/removes ✓.
   Approve/Reject is separate and applies the current
   selected permissions.
========================================================= */

const PERMISSIONS = [
  ["data_entry", "Data Entry", "Enter maintenance information"],
  ["view", "View", "View permitted information"],
  ["print_export", "Print / Export", "PDF, Excel and print"],
  ["master_modify", "Master Data Modification", "Modify authorised master data"],
  ["analysis_reports", "Analysis / Reports", "Reports and analysis"],
  ["smp_sop_history", "SMP/SOP/Troubleshooting", "SMP, SOP, troubleshooting, history"],
  ["attendance_manpower", "Attendance / Manpower", "Attendance and manpower"],
  ["maintenance_modules", "Maintenance Modules", "Maintenance module access"],
  ["full_access", "Full Access", "All normal permissions"]
];

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(x => PERMISSIONS.some(([key]) => key === x)))];
}

async function sendAuthorityAssignmentMenu(
  to,
  employeeNumber,
  selectedPermissions = []
) {
  const selected = new Set(normalizePermissions(selectedPermissions));

  const rows = PERMISSIONS.map(([key, title, description]) => ({
    id: `perm_toggle_${key}_${employeeNumber}`,
    title: `${selected.has(key) ? "✓ " : ""}${title}`.slice(0, 24),
    description
  }));

  const chosen =
    PERMISSIONS
      .filter(([key]) => selected.has(key))
      .map(([, title]) => `✓ ${title}`)
      .join("\n") || "No authorities selected";

  await sendInteractive(to, {
    type: "list",
    body: {
      text:
        `Assign authorities for Employee ${employeeNumber}\n\n` +
        `Selected:\n${chosen}\n\n` +
        "Tap an option to toggle ✓."
    },
    action: {
      button: "Select Authority",
      sections: [
        {
          title: "Permissions",
          rows
        }
      ]
    }
  });

  await sendWhatsAppApprovalDecisionButtons(
    to,
    employeeNumber,
    selectedPermissions
  );
}

async function sendWhatsAppApprovalDecisionButtons(
  to,
  employeeNumber,
  selectedPermissions = []
) {
  const selected = new Set(normalizePermissions(selectedPermissions));

  const chosen =
    PERMISSIONS
      .filter(([key]) => selected.has(key))
      .map(([, title]) => `✓ ${title}`)
      .join("\n") || "No authorities selected";

  await sendInteractive(to, {
    type: "button",
    body: {
      text:
        `Employee ${employeeNumber}\n\n` +
        `Selected authorities:\n${chosen}\n\n` +
        "After selecting the required authorities, tap Approve."
    },
    action: {
      buttons: [
        {
          type: "reply",
          reply: {
            id: `final_approve_${employeeNumber}`,
            title: "Approve"
          }
        },
        {
          type: "reply",
          reply: {
            id: `final_reject_${employeeNumber}`,
            title: "Reject"
          }
        }
      ]
    }
  });
}

async function processAuthorityAction(from, actionId) {
  const match = actionId.match(
    /^perm_toggle_(data_entry|view|print_export|master_modify|analysis_reports|smp_sop_history|attendance_manpower|maintenance_modules|full_access)_(\d+)$/i
  );

  if (!match) return false;

  if (!isOwner(from)) {
    await sendWhatsAppText(
      from,
      "You are not authorised to assign permissions."
    );
    return true;
  }

  const action = match[1].toLowerCase();
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
  let permissions = normalizePermissions(user.permissions);

  if (action === "full_access") {
    const allKeys = PERMISSIONS.map(([key]) => key);
    const fullSelected = permissions.includes("full_access");

    permissions = fullSelected ? [] : allKeys;
  } else {
    if (permissions.includes(action)) {
      permissions = permissions.filter(x => x !== action);
    } else {
      permissions.push(action);
    }

    /* Data Entry requires View */
    if (
      action === "data_entry" &&
      permissions.includes("data_entry") &&
      !permissions.includes("view")
    ) {
      permissions.push("view");
    }

    /* If any normal permission is manually changed,
       Full Access is no longer considered selected. */
    permissions = permissions.filter(x => x !== "full_access");
  }

  permissions = normalizePermissions(permissions);

  await pool.query(
    `
    UPDATE users
    SET permissions=$1::jsonb,
        updated_at=CURRENT_TIMESTAMP
    WHERE employee_number=$2
    `,
    [JSON.stringify(permissions), employeeNumber]
  );

  await sendAuthorityAssignmentMenu(
    from,
    employeeNumber,
    permissions
  );

  return true;
}

/* =========================================================
   OWNER APPROVAL
========================================================= */

async function processApprovalCommand(from, text) {
  if (!isOwner(from)) return false;

  const approve = text.match(/^approve\s+(\d+)$/i);
  const reject = text.match(/^reject\s+(\d+)$/i);

  if (!approve && !reject) return false;

  const employeeNumber = (approve || reject)[1];
  const action = approve ? "approve" : "reject";

  return processApprovalAction(from, action, employeeNumber);
}

async function processApprovalAction(from, action, employeeNumber) {
  if (!isOwner(from)) {
    await sendWhatsAppText(
      from,
      "You are not authorised to approve or reject registrations."
    );
    return true;
  }

  const result = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1`,
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

  if (action === "approve") {
    const permissions = normalizePermissions(user.permissions);

    await pool.query(
      `
      UPDATE users
      SET approval_status='approved',
          system_role='user',
          permissions=$1::jsonb,
          updated_at=CURRENT_TIMESTAMP
      WHERE employee_number=$2
      `,
      [JSON.stringify(permissions), employeeNumber]
    );

    await pool.query(
      `
      UPDATE registration_requests
      SET status='approved',
          reviewed_at=CURRENT_TIMESTAMP,
          reviewed_by=$1
      WHERE employee_number=$2 AND status='pending'
      `,
      [from, employeeNumber]
    );

    const permissionText =
      PERMISSIONS
        .filter(([key]) => permissions.includes(key))
        .map(([, title]) => `• ${title}`)
        .join("\n") || "• No authorities assigned";

    await sendWhatsAppText(
      user.whatsapp_number,
      `Registration approved ✅\n\n` +
      `Welcome to LMMM Maintenance AI Agent, ${user.name}.\n\n` +
      `Your authorised access:\n${permissionText}\n\n` +
      `Send "Hi" to open the Maintenance Menu.`
    );

    await sendWhatsAppText(
      from,
      `Employee ${employeeNumber}: APPROVED successfully.\n\nAuthorities assigned:\n${permissionText}`
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

    await pool.query(
      `
      UPDATE registration_requests
      SET status='rejected',
          reviewed_at=CURRENT_TIMESTAMP,
          reviewed_by=$1
      WHERE employee_number=$2 AND status='pending'
      `,
      [from, employeeNumber]
    );

    await sendWhatsAppText(
      user.whatsapp_number,
      `Registration rejected ❌\n\n` +
      `Please contact the authorised administrator for correction.`
    );

    await sendWhatsAppText(
      from,
      `Employee ${employeeNumber}: REJECTED successfully.`
    );
  }

  return true;
}

/* =========================================================
   RESET / CORRECTION
========================================================= */

async function resetRegistration(from) {
  await pool.query(
    `
    UPDATE users
    SET name=NULL,
        employee_number=NULL,
        designation=NULL,
        area_of_working=NULL,
        section_department=NULL,
        system_role='pending',
        approval_status='pending',
        permissions='[]'::jsonb,
        updated_at=CURRENT_TIMESTAMP
    WHERE whatsapp_number=$1
    `,
    [from]
  );

  await pool.query(
    `
    UPDATE registration_requests
    SET status='cancelled',
        reviewed_at=CURRENT_TIMESTAMP
    WHERE whatsapp_number=$1 AND status='pending'
    `,
    [from]
  );

  await sendWhatsAppText(from, REGISTRATION_MESSAGE);
}

/* =========================================================
   SUPER ADMIN USER MANAGEMENT
========================================================= */

async function sendUserManagementMenu(to, employeeNumber) {
  if (!isOwner(to)) {
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

  await sendInteractive(to, {
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
  });

  return true;
}

async function startUserEdit(from, actionId) {
  const match = actionId.match(
    /^edit_(designation|area|section)_(\d+)$/i
  );

  if (!match) return false;

  if (!isOwner(from)) {
    await sendWhatsAppText(
      from,
      "You are not authorised to modify user details."
    );
    return true;
  }

  const field = match[1].toLowerCase();
  const employeeNumber = match[2];

  const result = await pool.query(
    `SELECT 1 FROM users WHERE employee_number=$1`,
    [employeeNumber]
  );

  if (!result.rowCount) {
    await sendWhatsAppText(
      from,
      `No user found for Employee Number ${employeeNumber}.`
    );
    return true;
  }

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

  return true;
}

async function processAdminEditText(from, text) {
  if (!isOwner(from)) return false;

  const result = await pool.query(
    `SELECT * FROM admin_edit_sessions WHERE whatsapp_number=$1`,
    [from]
  );

  if (!result.rowCount) return false;

  const session = result.rows[0];
  const value = cleanValue(text);

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
  if (!column) {
    await pool.query(
      `DELETE FROM admin_edit_sessions WHERE whatsapp_number=$1`,
      [from]
    );
    return true;
  }

  const oldValue = user[column];

  const finalValue =
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
    [finalValue, session.employee_number]
  );

  await pool.query(
    `
    INSERT INTO user_change_audit
      (whatsapp_number, employee_number, changed_by,
       field_name, old_value, new_value)
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      user.whatsapp_number,
      session.employee_number,
      from,
      session.field_name,
      oldValue,
      finalValue
    ]
  );

  await pool.query(
    `DELETE FROM admin_edit_sessions WHERE whatsapp_number=$1`,
    [from]
  );

  await sendWhatsAppText(
    from,
    `Employee ${session.employee_number} updated successfully ✅\n` +
    `${session.field_name}: ${finalValue}`
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

  await sendWhatsAppText(
    from,
    `I need a little more information to complete registration.\n\n` +
    `Missing:\n${missing.map(x => `• ${x}`).join("\n")}\n\n` +
    `You can send all details together in one message.`
  );
}

/* =========================================================
   MAINTENANCE FIELD
========================================================= */

async function processMaintenanceField(from, text, user) {
  const n = Number(text.trim());

  const names = {
    1: "LOG BOOK",
    2: "BREAKDOWN / DELAY MANAGEMENT",
    3: "DEFECT MANAGEMENT",
    4: "MAINTENANCE JOBS / WORK ORDERS",
    5: "PREVENTIVE MAINTENANCE (PM)",
    6: "INSPECTION & CONDITION MONITORING",
    7: "CBM / VIBRATION MONITORING",
    8: "EQUIPMENT MASTER",
    9: "SAP SUB-EQUIPMENT",
    10: "MAINTENANCE HISTORY",
    11: "SPARE PARTS MANAGEMENT",
    12: "DRAWINGS & TECHNICAL DOCUMENTS",
    13: "SMP – STANDARD MAINTENANCE PROCEDURE",
    14: "SOP – STANDARD OPERATING PROCEDURE",
    15: "TROUBLESHOOTING & FAILURE ANALYSIS",
    16: "RCM / RELIABILITY MANAGEMENT",
    17: "SHUTDOWN MAINTENANCE",
    18: "EMPLOYEE ATTENDANCE",
    19: "CONTRACT WORKER ATTENDANCE",
    20: "MANPOWER / LABOUR MANAGEMENT"
  };

  if (!Number.isInteger(n) || !names[n]) {
    await sendWhatsAppText(from, getMainMenu(user));
    return;
  }

  await sendWhatsAppText(
    from,
    `${names[n]}\n\nModule selected.\n\n` +
    `The module workflow will be connected to the LMMM maintenance data layer.`
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
  } else {
    return;
  }

  console.log("[INCOMING]", from, text || interactiveAction);

  /* Interactive actions */
  if (interactiveAction) {
    /* User management first */
    if (await startUserEdit(from, interactiveAction)) {
      return;
    }

    /* Authority toggle */
    if (await processAuthorityAction(from, interactiveAction)) {
      return;
    }

    /* Final approval / rejection */
    const finalMatch = interactiveAction.match(
      /^final_(approve|reject)_(\d+)$/i
    );

    if (finalMatch) {
      if (!isOwner(from)) {
        await sendWhatsAppText(
          from,
          "You are not authorised to approve or reject registrations."
        );
        return;
      }

      const action = finalMatch[1].toLowerCase();
      const employeeNumber = finalMatch[2];

      await processApprovalAction(
        from,
        action,
        employeeNumber
      );

      return;
    }

    /* Legacy approval buttons */
    const oldMatch = interactiveAction.match(
      /^(approve|reject)_(\d+)$/i
    );

    if (oldMatch) {
      if (!isOwner(from)) {
        await sendWhatsAppText(
          from,
          "You are not authorised to approve or reject registrations."
        );
        return;
      }

      await processApprovalAction(
        from,
        oldMatch[1].toLowerCase(),
        oldMatch[2]
      );

      return;
    }
  }

  /*
    IMPORTANT:
    RESET is checked before admin-edit session handling.
    This prevents RESET from failing because an edit session
    is present or missing.
  */
  if (text && isResetCommand(text)) {
    await resetRegistration(from);
    return;
  }

  /* Text approval commands */
  if (text && await processApprovalCommand(from, text)) {
    return;
  }

  /* Super Admin pending user edit */
  if (text && await processAdminEditText(from, text)) {
    return;
  }

  /* Super Admin user management */
  const manageMatch =
    text && text.match(/^MANAGE USER\s+(\d+)$/i);

  if (manageMatch && isOwner(from)) {
    await sendUserManagementMenu(
      from,
      manageMatch[1]
    );
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
      "Registration submitted successfully.\n*Status: Pending Approval ⏳*"
    );
    return;
  }

  if (user.approval_status === "rejected") {
    await sendWhatsAppText(
      from,
      'Your registration was rejected. Send "RESET REGISTRATION" to enter corrected details.'
    );
    return;
  }

  if (user.approval_status === "approved") {
    if (isGreeting(text)) {
      await sendWhatsAppText(
        from,
        getMainMenu(user)
      );
      return;
    }

    await processMaintenanceField(
      from,
      text,
      user
    );
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
    database_configured: Boolean(
      process.env.DATABASE_URL
    ),
    whatsapp_configured: Boolean(
      PHONE_NUMBER_ID && ACCESS_TOKEN
    ),
    ai_configured: Boolean(
      process.env.OPENAI_API_KEY
    ),
    owner_approval_configured:
      OWNER_NUMBERS.size > 0
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
