import "dotenv/config";

import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* =========================================================
   DATABASE CONNECTION
========================================================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
  try {
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("[DATABASE] Users table ready");
  } catch (error) {
    console.error("[DATABASE] Initialization error:", error);
  }
}

/* =========================================================
   META / WHATSAPP CONFIGURATION
========================================================= */

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const GRAPH_API_VERSION = "v26.0";

/* =========================================================
   REGISTRATION MESSAGE
========================================================= */

const REGISTRATION_MESSAGE = `
Welcome to LMMM Maintenance AI Agent 👋

To get started, please enter your details:

1. Name
2. Employee Number
3. Designation
4. Area of Working
5. Section / Department
`.trim();

/* =========================================================
   MAIN MAINTENANCE FIELD MENU
========================================================= */

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
   WHATSAPP SEND MESSAGE
========================================================= */

async function sendWhatsAppText(to, message) {
  try {
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
          to: to,
          type: "text",
          text: {
            body: message
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("[WHATSAPP] Send error:", data);
    } else {
      console.log("[WHATSAPP] Message sent:", to);
    }

    return data;
  } catch (error) {
    console.error("[WHATSAPP] Exception:", error);
  }
}

/* =========================================================
   TEXT NORMALIZATION
========================================================= */

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}

/* =========================================================
   GREETING DETECTION
========================================================= */

function isGreeting(text) {
  const value = normalizeText(text);

  const greetings = [
    "hi",
    "hello",
    "hey",
    "hii",
    "hiii",
    "hiiii",
    "start",
    "hai"
  ];

  return greetings.includes(value);
}

/* =========================================================
   REGISTRATION PROCESS
========================================================= */

async function processRegistration(from, text) {
  let userResult;

  try {
    userResult = await pool.query(
      `SELECT * FROM users WHERE whatsapp_number = $1`,
      [from]
    );
  } catch (error) {
    console.error("[DATABASE] User lookup error:", error);
    await sendWhatsAppText(
      from,
      "System error occurred while accessing registration data. Please try again."
    );
    return;
  }

  let user = userResult.rows[0];

  /* ---------------------------------------------------------
     FIRST TIME USER
  --------------------------------------------------------- */

  if (!user) {
    try {
      await pool.query(
        `
        INSERT INTO users (
          whatsapp_number,
          system_role,
          approval_status
        )
        VALUES ($1, 'pending', 'pending')
        `,
        [from]
      );

      console.log("[REGISTRATION] New user created:", from);

      await sendWhatsAppText(from, REGISTRATION_MESSAGE);
      return;

    } catch (error) {
      console.error("[DATABASE] Registration creation error:", error);

      await sendWhatsAppText(
        from,
        "Unable to start registration. Please try again."
      );

      return;
    }
  }

  /* ---------------------------------------------------------
     GREETING AFTER REGISTRATION STARTED
  --------------------------------------------------------- */

  if (isGreeting(text)) {

    if (!user.name) {
      await sendWhatsAppText(
        from,
        "Please enter your Name."
      );
      return;
    }

    if (!user.employee_number) {
      await sendWhatsAppText(
        from,
        "Please enter your Employee Number."
      );
      return;
    }

    if (!user.designation) {
      await sendWhatsAppText(
        from,
        "Please enter your Designation."
      );
      return;
    }

    if (!user.area_of_working) {
      await sendWhatsAppText(
        from,
        "Please enter your Area of Working."
      );
      return;
    }

    if (!user.section_department) {
      await sendWhatsAppText(
        from,
        "Please enter your Section / Department."
      );
      return;
    }

    if (user.approval_status === "pending") {
      await sendWhatsAppText(
        from,
        `
Your registration details have been submitted successfully.

Approval Status: Pending ⏳

Please wait for authorised administrator approval.
        `.trim()
      );
      return;
    }

    if (user.approval_status === "approved") {
      await sendWhatsAppText(
        from,
        getMainMenu(user)
      );
      return;
    }
  }

  /* ---------------------------------------------------------
     NAME
  --------------------------------------------------------- */

  if (!user.name) {

    await pool.query(
      `
      UPDATE users
      SET name = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE whatsapp_number = $2
      `,
      [text.trim(), from]
    );

    await sendWhatsAppText(
      from,
      "Please enter your Employee Number."
    );

    return;
  }

  /* ---------------------------------------------------------
     EMPLOYEE NUMBER
  --------------------------------------------------------- */

  if (!user.employee_number) {

    const employeeNumber = text.trim();

    if (!/^\d+$/.test(employeeNumber)) {

      await sendWhatsAppText(
        from,
        `
Invalid Employee Number ❌

Please enter numbers only (0-9).
        `.trim()
      );

      return;
    }

    try {

      await pool.query(
        `
        UPDATE users
        SET employee_number = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE whatsapp_number = $2
        `,
        [employeeNumber, from]
      );

    } catch (error) {

      if (error.code === "23505") {

        await sendWhatsAppText(
          from,
          `
This Employee Number is already registered.

Please contact the authorised administrator for verification.
          `.trim()
        );

        return;
      }

      console.error("[DATABASE] Employee number error:", error);

      await sendWhatsAppText(
        from,
        "Unable to save Employee Number. Please try again."
      );

      return;
    }

    await sendWhatsAppText(
      from,
      "Please enter your Designation."
    );

    return;
  }

  /* ---------------------------------------------------------
     DESIGNATION
  --------------------------------------------------------- */

  if (!user.designation) {

    await pool.query(
      `
      UPDATE users
      SET designation = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE whatsapp_number = $2
      `,
      [text.trim(), from]
    );

    await sendWhatsAppText(
      from,
      "Please enter your Area of Working."
    );

    return;
  }

  /* ---------------------------------------------------------
     AREA OF WORKING
  --------------------------------------------------------- */

  if (!user.area_of_working) {

    await pool.query(
      `
      UPDATE users
      SET area_of_working = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE whatsapp_number = $2
      `,
      [text.trim(), from]
    );

    await sendWhatsAppText(
      from,
      "Please enter your Section / Department."
    );

    return;
  }

  /* ---------------------------------------------------------
     SECTION / DEPARTMENT
  --------------------------------------------------------- */

  if (!user.section_department) {

    await pool.query(
      `
      UPDATE users
      SET section_department = $1,
          approval_status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      WHERE whatsapp_number = $2
      `,
      [text.trim(), from]
    );

    await sendWhatsAppText(
      from,
      `
Registration completed successfully ✅

Approval Status: Pending ⏳

Your details have been submitted for authorised administrator approval.
      `.trim()
    );

    return;
  }

  /* ---------------------------------------------------------
     PENDING APPROVAL
  --------------------------------------------------------- */

  if (user.approval_status === "pending") {

    await sendWhatsAppText(
      from,
      `
Your registration is already completed.

Approval Status: Pending ⏳

Please wait for authorised administrator approval.
      `.trim()
    );

    return;
  }

  /* ---------------------------------------------------------
     APPROVED USER
  --------------------------------------------------------- */

  if (user.approval_status === "approved") {

    await sendWhatsAppText(
      from,
      getMainMenu(user)
    );

    return;
  }
}

/* =========================================================
   MAINTENANCE FIELD PROCESSING
========================================================= */

async function processMaintenanceField(from, text, user) {

  const value = text.trim();

  const fieldNumber = Number(value);

  if (!Number.isInteger(fieldNumber)) {
    await sendWhatsAppText(
      from,
      getMainMenu(user)
    );
    return;
  }

  switch (fieldNumber) {

    case 1:
      await sendWhatsAppText(
        from,
        "LOG BOOK\n\nLog Book module selected.\n\nMaintenance log entry and retrieval functionality will be connected here."
      );
      break;

    case 2:
      await sendWhatsAppText(
        from,
        "BREAKDOWN / DELAY MANAGEMENT\n\nBreakdown and delay management module selected."
      );
      break;

    case 3:
      await sendWhatsAppText(
        from,
        "DEFECT MANAGEMENT\n\nDefect management module selected."
      );
      break;

    case 4:
      await sendWhatsAppText(
        from,
        "MAINTENANCE JOBS / WORK ORDERS\n\nMaintenance Jobs / Work Orders module selected."
      );
      break;

    case 5:
      await sendWhatsAppText(
        from,
        "PREVENTIVE MAINTENANCE (PM)\n\nPreventive Maintenance module selected."
      );
      break;

    case 6:
      await sendWhatsAppText(
        from,
        "INSPECTION & CONDITION MONITORING\n\nInspection and Condition Monitoring module selected."
      );
      break;

    case 7:
      await sendWhatsAppText(
        from,
        "CBM / VIBRATION MONITORING\n\nCondition Based Maintenance and Vibration Monitoring module selected."
      );
      break;

    case 8:
      await sendWhatsAppText(
        from,
        "EQUIPMENT MASTER\n\nAuthorised Equipment Master module selected."
      );
      break;

    case 9:
      await sendWhatsAppText(
        from,
        "SAP SUB-EQUIPMENT\n\nSAP Sub-Equipment module selected."
      );
      break;

    case 10:
      await sendWhatsAppText(
        from,
        "MAINTENANCE HISTORY\n\nMaintenance History module selected."
      );
      break;

    case 11:
      await sendWhatsAppText(
        from,
        "SPARE PARTS MANAGEMENT\n\nSpare Parts Management module selected."
      );
      break;

    case 12:
      await sendWhatsAppText(
        from,
        "DRAWINGS & TECHNICAL DOCUMENTS\n\nTechnical Documents and Drawings module selected."
      );
      break;

    case 13:
      await sendWhatsAppText(
        from,
        "SMP – STANDARD MAINTENANCE PROCEDURE\n\nSMP module selected."
      );
      break;

    case 14:
      await sendWhatsAppText(
        from,
        "SOP – STANDARD OPERATING PROCEDURE\n\nSOP module selected."
      );
      break;

    case 15:
      await sendWhatsAppText(
        from,
        "TROUBLESHOOTING & FAILURE ANALYSIS\n\nTroubleshooting and Failure Analysis module selected."
      );
      break;

    case 16:
      await sendWhatsAppText(
        from,
        "RCM / RELIABILITY MANAGEMENT\n\nReliability Centred Maintenance module selected."
      );
      break;

    case 17:
      await sendWhatsAppText(
        from,
        "SHUTDOWN MAINTENANCE\n\nShutdown Maintenance module selected."
      );
      break;

    case 18:
      await sendWhatsAppText(
        from,
        "EMPLOYEE ATTENDANCE\n\nEmployee Attendance module selected."
      );
      break;

    case 19:
      await sendWhatsAppText(
        from,
        "CONTRACT WORKER ATTENDANCE\n\nContract Worker Attendance module selected."
      );
      break;

    case 20:
      await sendWhatsAppText(
        from,
        "MANPOWER / LABOUR MANAGEMENT\n\nManpower and Labour Management module selected."
      );
      break;

    default:
      await sendWhatsAppText(
        from,
        `
Invalid Maintenance Field ❌

Please select a field from 1 to 20.

${getMainMenu(user)}
        `.trim()
      );
  }
}

/* =========================================================
   INCOMING MESSAGE PROCESSOR
========================================================= */

async function processIncomingMessage(message) {

  if (!message) return;

  if (message.type !== "text") {
    return;
  }

  const from = message.from;
  const text = message.text?.body?.trim();

  if (!from || !text) {
    return;
  }

  console.log("[INCOMING]", from, text);

  let result;

  try {

    result = await pool.query(
      `SELECT * FROM users WHERE whatsapp_number = $1`,
      [from]
    );

  } catch (error) {

    console.error("[DATABASE] Incoming user lookup error:", error);

    await sendWhatsAppText(
      from,
      "System error occurred. Please try again."
    );

    return;
  }

  const user = result.rows[0];

  /* ---------------------------------------------------------
     NEW USER
  --------------------------------------------------------- */

  if (!user) {
    await processRegistration(from, text);
    return;
  }

  /* ---------------------------------------------------------
     INCOMPLETE REGISTRATION
  --------------------------------------------------------- */

  if (
    !user.name ||
    !user.employee_number ||
    !user.designation ||
    !user.area_of_working ||
    !user.section_department
  ) {
    await processRegistration(from, text);
    return;
  }

  /* ---------------------------------------------------------
     PENDING APPROVAL
  --------------------------------------------------------- */

  if (user.approval_status === "pending") {

    if (isGreeting(text)) {

      await sendWhatsAppText(
        from,
        `
Your registration is completed successfully.

Approval Status: Pending ⏳

Please wait for authorised administrator approval.
        `.trim()
      );

    } else {

      await sendWhatsAppText(
        from,
        `
Your registration is under approval.

Approval Status: Pending ⏳
        `.trim()
      );

    }

    return;
  }

  /* ---------------------------------------------------------
     APPROVED USER
  --------------------------------------------------------- */

  if (user.approval_status === "approved") {

    if (isGreeting(text)) {

      await sendWhatsAppText(
        from,
        getMainMenu(user)
      );

      return;
    }

    await processMaintenanceField(from, text, user);
    return;
  }

  /* ---------------------------------------------------------
     OTHER STATUS
  --------------------------------------------------------- */

  await sendWhatsAppText(
    from,
    `
Your account is not currently authorised to access the LMMM Maintenance AI Agent.

Please contact the authorised administrator.
    `.trim()
  );
}

/* =========================================================
   META WEBHOOK VERIFICATION
========================================================= */

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {

    console.log("[WEBHOOK] Verification successful");

    res.status(200).send(challenge);

  } else {

    console.log("[WEBHOOK] Verification failed");

    res.sendStatus(403);
  }
});

/* =========================================================
   META WEBHOOK POST
========================================================= */

app.post("/webhook", async (req, res) => {

  try {

    res.sendStatus(200);

    const body = req.body;

    if (
      body.object !== "whatsapp_business_account" ||
      !body.entry
    ) {
      return;
    }

    for (const entry of body.entry) {

      const changes = entry.changes || [];

      for (const change of changes) {

        const value = change.value;

        if (!value || !value.messages) {
          continue;
        }

        for (const message of value.messages) {

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
   HEALTH CHECK
========================================================= */

app.get("/", (req, res) => {

  res.status(200).send(
    "LMMM Mechanical Maintenance AI Agent is running."
  );

});

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {

  await initializeDatabase();

  app.listen(PORT, () => {

    console.log(
      `LMMM AI Maintenance Agent listening on ${PORT}`
    );

  });

}

startServer();
