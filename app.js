import "dotenv/config";
import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || "")
  .split(",").map(x => x.replace(/\D/g, "")).filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const PERMISSIONS = [
  ["data_entry", "Data Entry"],
  ["view", "View"],
  ["print_export", "Print / Export"],
  ["master_data", "Master Data Modification"],
  ["analysis_reports", "Analysis / Reports"],
  ["knowledge", "SMP / SOP / Troubleshooting / History"],
  ["attendance_manpower", "Attendance / Manpower"],
  ["maintenance_modules", "Maintenance Modules"]
];

const FULL_ACCESS = "full_access";

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      whatsapp_number TEXT UNIQUE NOT NULL,
      name TEXT,
      employee_number TEXT,
      designation TEXT,
      area_of_working TEXT,
      section_department TEXT,
      role TEXT DEFAULT 'user',
      approval_status TEXT DEFAULT 'pending',
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_change_audit (
      id SERIAL PRIMARY KEY,
      employee_number TEXT,
      whatsapp_number TEXT,
      changed_by TEXT,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("[DATABASE] Users table ready");
}

function normalizeNumber(v) {
  return String(v || "").replace(/\D/g, "");
}

function isSuperAdmin(from) {
  return SUPER_ADMIN_NUMBERS.includes(normalizeNumber(from));
}

async function getUser(wa) {
  const r = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number=$1 LIMIT 1`,
    [normalizeNumber(wa)]
  );
  return r.rows[0] || null;
}

async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeNumber(to),
      type: "text",
      text: { body }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[WHATSAPP TEXT ERROR]", data);
  }
  return data;
}

async function sendInteractive(to, interactive) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizeNumber(to),
      type: "interactive",
      interactive
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[WHATSAPP INTERACTIVE ERROR]", data);
  }
  return data;
}

async function sendApprovalButtons(to, employeeNumber) {
  return sendInteractive(to, {
    type: "button",
    body: {
      text: `Employee: ${employeeNumber}\n\nSelect the required permissions above, then approve or reject this registration.`
    },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: `approve:${employeeNumber}`, title: "Approve" }
        },
        {
          type: "reply",
          reply: { id: `reject:${employeeNumber}`, title: "Reject" }
        }
      ]
    }
  });
}

function permissionText(selected) {
  return PERMISSIONS.map(([key, label]) =>
    `${selected.includes(key) ? "☑️" : "☐"} ${label}`
  ).join("\n") + `\n${selected.includes(FULL_ACCESS) ? "☑️" : "☐"} Full Access`;
}

async function sendAuthorityMenu(to, employeeNumber, selected = []) {
  // WhatsApp interactive list supports selecting one item per message.
  // We simulate checkbox selection by saving each selection and re-sending the list.
  const rows = [
    ...PERMISSIONS.map(([key, label]) => ({
      id: `perm:${employeeNumber}:${key}`,
      title: `${selected.includes(key) ? "☑️ " : "☐ "}${label}`.slice(0, 24)
    })),
    {
      id: `perm:${employeeNumber}:${FULL_ACCESS}`,
      title: `${selected.includes(FULL_ACCESS) ? "☑️ " : "☐ "}Full Access`
    }
  ];

  const result = await sendInteractive(to, {
    type: "list",
    body: {
      text:
        `AUTHORITY SELECTION\n\nEmployee: ${employeeNumber}\n\n` +
        `${permissionText(selected)}\n\nTap an option to select/unselect it.`
    },
    action: {
      button: "Select Permission",
      sections: [{ title: "Permissions", rows }]
    }
  });

  await sendApprovalButtons(to, employeeNumber);
  return result;
}

async function submitRegistration(from, details) {
  const wa = normalizeNumber(from);

  await pool.query(`
    INSERT INTO users
      (whatsapp_number,name,employee_number,designation,area_of_working,section_department,approval_status,role,permissions,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,'pending','user','[]'::jsonb,NOW())
    ON CONFLICT (whatsapp_number)
    DO UPDATE SET
      name=EXCLUDED.name,
      employee_number=EXCLUDED.employee_number,
      designation=EXCLUDED.designation,
      area_of_working=EXCLUDED.area_of_working,
      section_department=EXCLUDED.section_department,
      approval_status='pending',
      permissions='[]'::jsonb,
      updated_at=NOW()
  `, [
    wa,
    details.name,
    details.employee_number,
    details.designation,
    details.area_of_working,
    details.section_department
  ]);

  await sendWhatsAppText(
    wa,
    "Registration submitted successfully.\n*Status: Pending Approval ⏳*"
  );

  for (const owner of SUPER_ADMIN_NUMBERS) {
    if (owner === wa) continue;

    await sendWhatsAppText(
      owner,
      `NEW REGISTRATION\n\nName: ${details.name}\nEmployee No: ${details.employee_number}\nDesignation: ${details.designation}\nArea of Working: ${details.area_of_working}\nSection / Department: ${details.section_department}`
    );

    await sendAuthorityMenu(owner, details.employee_number, []);
  }
}

async function processRegistration(from, text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

  if (lines.length >= 5) {
    await submitRegistration(from, {
      name: lines[0],
      employee_number: lines[1],
      designation: lines[2],
      area_of_working: lines[3],
      section_department: lines[4]
    });
    return true;
  }

  return false;
}

async function resetRegistration(from) {
  await pool.query(
    `DELETE FROM users WHERE whatsapp_number=$1`,
    [normalizeNumber(from)]
  );
  await sendWhatsAppText(
    from,
    "Your registration details have been reset.\nPlease send all 5 details in one message:\n\nName\nEmployee Number\nDesignation\nArea of Working\nSection / Department"
  );
}

async function processAuthorityAction(from, actionId) {
  if (!isSuperAdmin(from)) {
    await sendWhatsAppText(from, "You are not authorised to perform this action.");
    return true;
  }

  const m = /^perm:(.+):(.+)$/.exec(actionId);
  if (!m) return false;

  const employeeNumber = m[1];
  const permission = m[2];

  const r = await pool.query(
    `SELECT permissions FROM users WHERE employee_number=$1 LIMIT 1`,
    [employeeNumber]
  );

  if (!r.rows.length) {
    await sendWhatsAppText(from, "Employee registration not found.");
    return true;
  }

  let selected = Array.isArray(r.rows[0].permissions)
    ? r.rows[0].permissions
    : [];

  if (permission === FULL_ACCESS) {
    if (selected.includes(FULL_ACCESS)) {
      selected = [];
    } else {
      selected = [FULL_ACCESS, ...PERMISSIONS.map(x => x[0])];
    }
  } else if (selected.includes(FULL_ACCESS)) {
    // If Full Access was active and one individual permission is tapped,
    // remove Full Access and leave all individual permissions selected except that one.
    selected = PERMISSIONS.map(x => x[0]).filter(x => x !== permission);
  } else if (selected.includes(permission)) {
    selected = selected.filter(x => x !== permission);
  } else {
    selected.push(permission);
  }

  await pool.query(
    `UPDATE users SET permissions=$1::jsonb, updated_at=NOW() WHERE employee_number=$2`,
    [JSON.stringify(selected), employeeNumber]
  );

  await sendAuthorityMenu(from, employeeNumber, selected);
  return true;
}

async function processApprovalAction(from, actionId) {
  if (!isSuperAdmin(from)) {
    await sendWhatsAppText(from, "You are not authorised to approve registrations.");
    return true;
  }

  const m = /^(approve|reject):(.+)$/.exec(actionId);
  if (!m) return false;

  const decision = m[1];
  const employeeNumber = m[2];

  const r = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1 LIMIT 1`,
    [employeeNumber]
  );

  if (!r.rows.length) {
    await sendWhatsAppText(from, "Employee registration not found.");
    return true;
  }

  const user = r.rows[0];

  if (decision === "reject") {
    await pool.query(`
      UPDATE users
      SET approval_status='rejected', updated_at=NOW()
      WHERE employee_number=$1
    `, [employeeNumber]);

    await sendWhatsAppText(from, `Registration rejected.\nEmployee: ${employeeNumber}`);
    await sendWhatsAppText(user.whatsapp_number, "Your registration was rejected by Super Admin.");
    return true;
  }

  const permissions = Array.isArray(user.permissions) ? user.permissions : [];

  await pool.query(`
    UPDATE users
    SET approval_status='approved',
        role='user',
        permissions=$1::jsonb,
        updated_at=NOW()
    WHERE employee_number=$2
  `, [JSON.stringify(permissions), employeeNumber]);

  await sendWhatsAppText(
    from,
    `Registration approved successfully.\nEmployee: ${employeeNumber}\n\nAssigned Permissions:\n${permissionText(permissions)}`
  );

  await sendWhatsAppText(
    user.whatsapp_number,
    `Registration approved successfully. ✅\n\nAssigned Permissions:\n${permissionText(permissions)}`
  );

  return true;
}

async function processManageUser(from, text) {
  if (!isSuperAdmin(from)) {
    await sendWhatsAppText(from, "You are not authorised to manage users.");
    return true;
  }

  const m = /^MANAGE USER\s+(.+)$/i.exec(text.trim());
  if (!m) return false;

  const employeeNumber = m[1].trim();
  const r = await pool.query(
    `SELECT * FROM users WHERE employee_number=$1 LIMIT 1`,
    [employeeNumber]
  );

  if (!r.rows.length) {
    await sendWhatsAppText(from, "Employee number not found.");
    return true;
  }

  const u = r.rows[0];

  await sendInteractive(from, {
    type: "list",
    body: {
      text:
        `USER MANAGEMENT\n\nEmployee: ${u.employee_number}\n` +
        `Name: ${u.name}\nDesignation: ${u.designation}\n` +
        `Area: ${u.area_of_working}\nSection: ${u.section_department}`
    },
    action: {
      button: "Modify User",
      sections: [{
        title: "Select Field",
        rows: [
          { id: `edit:${employeeNumber}:designation`, title: "Designation" },
          { id: `edit:${employeeNumber}:area`, title: "Area of Working" },
          { id: `edit:${employeeNumber}:section`, title: "Section / Department" }
        ]
      }]
    }
  });

  return true;
}

async function processIncomingMessage(from, text, interactiveId = null) {
  const wa = normalizeNumber(from);
  const clean = String(text || "").trim();

  console.log("[INCOMING]", wa, clean || interactiveId || "");

  if (interactiveId) {
    if (interactiveId.startsWith("perm:")) {
      return processAuthorityAction(wa, interactiveId);
    }
    if (interactiveId.startsWith("approve:") || interactiveId.startsWith("reject:")) {
      return processApprovalAction(wa, interactiveId);
    }
    if (interactiveId.startsWith("edit:")) {
      if (!isSuperAdmin(wa)) {
        await sendWhatsAppText(wa, "You are not authorised to modify users.");
        return true;
      }
      const [, emp, field] = interactiveId.split(":");
      await sendWhatsAppText(wa, `Enter the new value for ${field}.`);
      return true;
    }
  }

  if (/^RESET REGISTRATION$/i.test(clean)) {
    await resetRegistration(wa);
    return true;
  }

  if (/^MANAGE USER\s+/i.test(clean)) {
    return processManageUser(wa, clean);
  }

  const existing = await getUser(wa);

  if (!existing || existing.approval_status !== "approved") {
    if (await processRegistration(wa, clean)) return true;

    await sendWhatsAppText(
      wa,
      "Please send your registration details in one message:\n\nName\nEmployee Number\nDesignation\nArea of Working\nSection / Department"
    );
    return true;
  }

  if (isSuperAdmin(wa)) {
    if (/^APPROVE\s+/i.test(clean)) {
      const emp = clean.replace(/^APPROVE\s+/i, "").trim();
      return processApprovalAction(wa, `approve:${emp}`);
    }
    if (/^REJECT\s+/i.test(clean)) {
      const emp = clean.replace(/^REJECT\s+/i, "").trim();
      return processApprovalAction(wa, `reject:${emp}`);
    }
  }

  await sendWhatsAppText(wa, "LMMM Maintenance AI Agent is ready.");
  return true;
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];

    for (const msg of messages) {
      const from = msg.from;
      let text = "";
      let interactiveId = null;

      if (msg.type === "text") {
        text = msg.text?.body || "";
      } else if (msg.type === "interactive") {
        interactiveId =
          msg.interactive?.list_reply?.id ||
          msg.interactive?.button_reply?.id ||
          null;
        text =
          msg.interactive?.list_reply?.title ||
          msg.interactive?.button_reply?.title ||
          "";
      }

      if (from) {
        await processIncomingMessage(from, text, interactiveId);
      }
    }
  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
  }
});

app.get("/", (req, res) => res.send("LMMM Maintenance AI Agent is running"));
app.get("/health", (req, res) => res.json({ ok: true }));

async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`LMMM AI Maintenance Agent listening on ${PORT}`);
    });
  } catch (err) {
    console.error("[START ERROR]", err);
    process.exit(1);
  }
}

startServer();
