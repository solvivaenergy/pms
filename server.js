require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/pms", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/pms/questionnaire.html"));

const {
  ODOO_URL,
  ODOO_DB,
  ODOO_USER,
  ODOO_API_KEY,
  HMAC_SECRET,
  PORT = 3001,
  DASHBOARD_PASSWORD,
} = process.env;

// ─── Helpers ──────────────────────────────────────────────

function generateToken(leadId) {
  return crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(String(leadId))
    .digest("hex");
}

function verifyToken(leadId, token) {
  const expected = generateToken(leadId);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch {
    return false;
  }
}

// Odoo JSON-RPC helper
async function odooRpc(service, method, args) {
  const res = await axios.post(
    `${ODOO_URL}/jsonrpc`,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "call",
      params: { service, method, args },
    },
    { timeout: 15000 },
  );
  if (res.data.error) {
    throw new Error(
      res.data.error.data?.message ||
        res.data.error.message ||
        "Odoo RPC error",
    );
  }
  return res.data.result;
}

async function odooAuthenticate() {
  return odooRpc("common", "authenticate", [
    ODOO_DB,
    ODOO_USER,
    ODOO_API_KEY,
    {},
  ]);
}

async function odooExecute(model, method, args, kwargs = {}) {
  const uid = await odooAuthenticate();
  return odooRpc("object", "execute_kw", [
    ODOO_DB,
    uid,
    ODOO_API_KEY,
    model,
    method,
    args,
    kwargs,
  ]);
}

// Dashboard auth helpers
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("=");
    if (i > 0) {
      cookies[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    }
  });
  return cookies;
}

function getDashboardToken() {
  return crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(`pms-dashboard:${DASHBOARD_PASSWORD}`)
    .digest("hex");
}

function checkDashboardAuth(req) {
  if (!DASHBOARD_PASSWORD) return false;
  const expected = getDashboardToken();
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const cookie = parseCookies(req).pms_session || "";
  const token = bearer || cookie;
  if (!token) return false;
  try {
    return (
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

function requireDashboardAuth(req, res, next) {
  if (checkDashboardAuth(req)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

// ─── Routes ───────────────────────────────────────────────

// Serve the questionnaire — validates partner_id + token
app.get("/pms", async (req, res) => {
  const { lead_id, token } = req.query;

  if (!lead_id || !token) {
    return res
      .status(400)
      .sendFile(path.join(__dirname, "public", "error.html"));
  }

  // Verify HMAC token (keyed on lead_id)
  if (!verifyToken(lead_id, token)) {
    return res
      .status(403)
      .send(
        buildErrorPage(
          "Invalid or tampered link. Please contact Solviva Energy for a new link.",
        ),
      );
  }

  try {
    // Fetch the CRM lead
    const leads = await odooExecute(
      "crm.lead",
      "search_read",
      [[["id", "=", parseInt(lead_id, 10)]]],
      {
        fields: [
          "id",
          "name",
          "partner_id",
          "partner_name",
          "email_from",
          "phone",
          "street",
          "city",
          "state_id",
          "country_id",
        ],
        limit: 1,
      },
    );

    if (!leads || leads.length === 0) {
      return res
        .status(404)
        .send(
          buildErrorPage(
            "Lead record not found. Please contact Solviva Energy.",
          ),
        );
    }

    // Check if already submitted for this lead
    const existing = await odooExecute(
      "maintenance.request",
      "search_read",
      [
        [
          ["x_pms_lead_id", "=", parseInt(lead_id, 10)],
          ["x_pms_submission_token", "=", token],
        ],
      ],
      { fields: ["id"], limit: 1 },
    );

    if (existing && existing.length > 0) {
      return res
        .status(400)
        .send(
          buildErrorPage(
            "You have already submitted a PMS request via this link. Our Aftersales team will be in touch within 2 business days.",
          ),
        );
    }

    const lead = leads[0];
    const partnerId = lead.partner_id?.[0] || null;

    // Build prefill — start with lead-level values
    const prefill = {
      name: lead.partner_name || lead.partner_id?.[1] || "",
      first_name: "",
      last_name: "",
      email: lead.email_from || "",
      phone: lead.phone || "",
      address: [
        lead.street,
        lead.city,
        lead.state_id?.[1],
        lead.country_id?.[1],
      ]
        .filter(Boolean)
        .join(", "),
    };

    // Enrich from res.partner — fetch firstname/lastname directly
    if (partnerId) {
      try {
        const partners = await odooExecute(
          "res.partner",
          "search_read",
          [[["id", "=", partnerId]]],
          { fields: ["firstname", "lastname", "email", "phone"], limit: 1 },
        );
        if (partners?.length > 0) {
          const p = partners[0];
          prefill.first_name =
            p.firstname && p.firstname !== false ? p.firstname : "";
          prefill.last_name =
            p.lastname && p.lastname !== false ? p.lastname : "";
          if (!prefill.email) prefill.email = p.email || "";
          if (!prefill.phone) prefill.phone = p.phone || "";
        }
      } catch (e) {
        console.warn("Partner enrich warning:", e.message);
      }
    }

    // Fallback: split full name if partner fields were empty
    if (!prefill.first_name && !prefill.last_name && prefill.name) {
      if (prefill.name.includes(",")) {
        const [last, ...rest] = prefill.name.split(/,\s*/);
        prefill.last_name = last.trim();
        prefill.first_name = rest.join(" ").trim();
      } else {
        const words = prefill.name.trim().split(/\s+/);
        prefill.last_name = words.length >= 2 ? words[words.length - 1] : "";
        prefill.first_name =
          words.length >= 2 ? words.slice(0, -1).join(" ") : prefill.name;
      }
    }

    // Inject prefill data and serve the page
    const html = require("fs")
      .readFileSync(
        path.join(__dirname, "public", "questionnaire.html"),
        "utf8",
      )
      .replace(
        "/* __PREFILL_PLACEHOLDER__ */",
        `window.__PREFILL__ = ${JSON.stringify(prefill)}; window.__LEAD_ID__ = ${JSON.stringify(lead_id)}; window.__TOKEN__ = ${JSON.stringify(token)};`,
      );

    return res.send(html);
  } catch (err) {
    console.error("Odoo lookup error:", err.message);
    // Still serve the form — server will re-validate on submission
    const html = require("fs")
      .readFileSync(
        path.join(__dirname, "public", "questionnaire.html"),
        "utf8",
      )
      .replace(
        "/* __PREFILL_PLACEHOLDER__ */",
        `window.__PREFILL__ = {}; window.__LEAD_ID__ = ${JSON.stringify(lead_id)}; window.__TOKEN__ = ${JSON.stringify(token)};`,
      );
    return res.send(html);
  }
});

// Handle questionnaire submission — create maintenance.request in Odoo
app.post("/pms/api/submit", async (req, res) => {
  const {
    lead_id,
    token,
    // Section A
    last_name,
    first_name,
    email,
    contact_number,
    site_address,
    // Section B
    preferred_date,
    preferred_time_slot,
    alternative_date,
    // Section C
    panel_location,
    access_equipment, // comma-separated values
    work_permit,
    work_permit_requirements,
    site_contact_name,
    site_contact_number,
    access_instructions,
    // Section D
    has_issues,
    issue_description,
    other_requests,
  } = req.body;

  // ── 1. Validate required fields ──
  const missing = [];
  if (!lead_id) missing.push("lead_id");
  if (!token) missing.push("token");
  if (!last_name) missing.push("Last Name");
  if (!first_name) missing.push("First Name");
  if (!email) missing.push("Email Address");
  if (!contact_number) missing.push("Contact Number");
  if (!site_address) missing.push("Site / Installation Address");
  if (!preferred_date) missing.push("Preferred PMS Date");
  if (!preferred_time_slot) missing.push("Preferred Time Slot");
  if (!panel_location) missing.push("Panel / Array Location");
  if (!access_equipment) missing.push("Access Equipment Required");
  if (!work_permit) missing.push("Work Permit Required");
  if (has_issues === undefined || has_issues === null || has_issues === "")
    missing.push("Issues field");

  if (missing.length > 0) {
    return res
      .status(400)
      .json({ error: `Missing required fields: ${missing.join(", ")}` });
  }

  // ── 2. Verify HMAC token (keyed on lead_id) ──
  if (!verifyToken(lead_id, token)) {
    return res.status(403).json({ error: "Invalid or tampered link." });
  }

  // ── 3. Validate preferred date is at least 10 days from today ──
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const prefDate = new Date(preferred_date);
  const diffDays = Math.floor((prefDate - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 10) {
    return res.status(400).json({
      error: "Preferred PMS date must be at least 10 days from today.",
    });
  }

  // ── 4. Check for duplicate submission ──
  try {
    const existing = await odooExecute(
      "maintenance.request",
      "search_read",
      [
        [
          ["x_pms_lead_id", "=", parseInt(lead_id, 10)],
          ["x_pms_submission_token", "=", token],
        ],
      ],
      { fields: ["id"], limit: 1 },
    );
    if (existing && existing.length > 0) {
      return res.status(400).json({
        error: "You have already submitted a PMS request via this link.",
      });
    }
  } catch (err) {
    console.error("Duplicate check error:", err.message);
    // Continue — creation will fail gracefully if truly duplicate
  }

  // ── 4b. Resolve partner_id from the lead ──
  let resolvedPartnerId = null;
  try {
    const leads = await odooExecute(
      "crm.lead",
      "search_read",
      [[["id", "=", parseInt(lead_id, 10)]]],
      { fields: ["partner_id"], limit: 1 },
    );
    if (leads?.length > 0) resolvedPartnerId = leads[0].partner_id?.[0] || null;
  } catch (err) {
    console.warn("Lead partner resolution warning:", err.message);
  }

  // ── 5. Map time slot to datetime ──
  const timeSlotMap = {
    morning: "08:00:00",
    afternoon: "13:00:00",
    flexible: "08:00:00",
  };
  const timeStr = timeSlotMap[preferred_time_slot] || "08:00:00";
  const scheduleDatetime = `${preferred_date} ${timeStr}`;

  // ── 6. Build description (human-readable summary) ──
  const equipmentList = Array.isArray(access_equipment)
    ? access_equipment.join(", ")
    : access_equipment;

  const description = `
PMS REQUEST FORM — SUBMITTED ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}

=== SECTION A: CLIENT & SITE INFORMATION ===
Name: ${last_name}, ${first_name}
Email: ${email}
Contact Number: ${contact_number}
Site / Installation Address: ${site_address}

=== SECTION B: PREFERRED PMS SCHEDULE ===
Preferred Date: ${preferred_date}
Preferred Time Slot: ${preferred_time_slot}
Alternative Date: ${alternative_date || "Not specified"}

=== SECTION C: SITE ACCESS REQUIREMENTS ===
Panel / Array Location: ${panel_location}
Access Equipment Required: ${equipmentList}
Work Permit Required: ${work_permit}
Work Permit Requirements: ${work_permit_requirements || "N/A"}
Site Contact Person: ${site_contact_name || "Same as above"} ${site_contact_number ? `(${site_contact_number})` : ""}
Additional Access Instructions: ${access_instructions || "None"}

=== SECTION D: SYSTEM CONDITION & CONCERNS ===
Issues Noticed Recently: ${has_issues === "yes" ? "Yes" : "No — everything seems to be working fine"}
Issue Description: ${issue_description || "N/A"}
Other Questions or Requests: ${other_requests || "None"}
`.trim();

  // ── 7. Create maintenance.request in Odoo ──
  let requestId;
  try {
    const requestName = `PMS Request — ${last_name}, ${first_name} (${preferred_date})`;

    const payload = {
      name: requestName,
      maintenance_type: "preventive",
      request_date: new Date().toISOString().split("T")[0],
      schedule_date: scheduleDatetime,
      description: description,
      // Custom Odoo Studio fields
      x_pms_last_name: last_name,
      x_pms_first_name: first_name,
      x_pms_email: email,
      x_pms_contact_number: contact_number,
      x_pms_site_address: site_address,
      x_pms_preferred_date: preferred_date,
      x_pms_preferred_time_slot: preferred_time_slot,
      x_pms_alt_date: alternative_date || false,
      x_pms_panel_location: panel_location,
      x_pms_access_equipment: equipmentList,
      x_pms_work_permit: work_permit,
      x_pms_work_permit_requirements: work_permit_requirements || "",
      x_pms_site_contact_name: site_contact_name || "",
      x_pms_site_contact_number: site_contact_number || "",
      x_pms_access_instructions: access_instructions || "",
      x_pms_has_issues: has_issues === "yes",
      x_pms_issue_description: issue_description || "",
      x_pms_other_requests: other_requests || "",
      x_pms_lead_id: parseInt(lead_id, 10),
      x_pms_crm_lead_id: parseInt(lead_id, 10), // Many2one → crm.lead
      x_pms_submission_token: token,
      // Partner resolved server-side from the lead
      ...(resolvedPartnerId ? { x_pms_partner_id: resolvedPartnerId } : {}),
    };

    requestId = await odooExecute("maintenance.request", "create", [payload]);
    console.log(
      `Maintenance request created: ID ${requestId} for lead ${lead_id}`,
    );

    // Link the new maintenance request to the CRM lead via Many2many
    try {
      await odooExecute("crm.lead", "write", [
        [parseInt(lead_id, 10)],
        { x_pms_request_ids: [[4, requestId]] },
      ]);
    } catch (linkErr) {
      console.warn(
        "Could not link maintenance request to CRM lead:",
        linkErr.message,
      );
    }
  } catch (err) {
    console.error("Odoo create error:", err.message);
    // Attempt fallback — create with only standard fields if custom fields fail
    try {
      const requestName = `PMS Request — ${last_name}, ${first_name} (${preferred_date})`;
      requestId = await odooExecute("maintenance.request", "create", [
        {
          name: requestName,
          maintenance_type: "preventive",
          request_date: new Date().toISOString().split("T")[0],
          schedule_date: scheduleDatetime,
          description: description,
        },
      ]);
      console.log(`Maintenance request created (fallback): ID ${requestId}`);
    } catch (fallbackErr) {
      console.error("Odoo fallback create error:", fallbackErr.message);
      return res.status(500).json({
        error:
          "Failed to submit your request. Please try again or contact Solviva Energy directly.",
      });
    }
  }

  return res.json({
    success: true,
    request_id: requestId,
    message:
      "Your PMS request has been submitted successfully. Our Aftersales team will contact you within 2 business days to confirm your schedule.",
  });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────

app.get("/pms/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Dashboard login
app.post("/pms/dashboard/login", (req, res) => {
  const { password } = req.body;
  if (!password || password !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Invalid password." });
  }
  return res.json({ token: getDashboardToken() });
});

// Generate a unique link for a lead
app.post(
  "/pms/dashboard/generate-link",
  requireDashboardAuth,
  async (req, res) => {
    const { lead_id } = req.body;

    if (!lead_id) {
      return res.status(400).json({ error: "lead_id is required." });
    }

    const id = parseInt(lead_id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid lead_id." });
    }

    // Verify lead exists and get partner details
    try {
      const leads = await odooExecute(
        "crm.lead",
        "search_read",
        [[["id", "=", id]]],
        {
          fields: ["id", "name", "partner_id", "partner_name", "email_from"],
          limit: 1,
        },
      );
      if (!leads || leads.length === 0) {
        return res.status(404).json({ error: `No lead found with ID ${id}.` });
      }
      const lead = leads[0];
      const token = generateToken(id);
      const baseUrl = process.env.BASE_URL
        ? process.env.BASE_URL.replace(/\/$/, "")
        : `${req.protocol}://${req.get("host")}`;
      const link = `${baseUrl}/pms?lead_id=${id}&token=${token}`;

      // Write link back to crm.lead so it's visible on the CRM record
      try {
        await odooExecute("crm.lead", "write", [
          [id],
          { x_pms_questionnaire_link: link },
        ]);
      } catch (writeErr) {
        console.warn("Could not write PMS link to CRM lead:", writeErr.message);
      }

      return res.json({
        lead_id: id,
        lead_name: lead.name,
        partner_id: lead.partner_id?.[0] || null,
        partner_name: lead.partner_name || lead.partner_id?.[1] || "",
        partner_email: lead.email_from || "",
        link,
        token,
      });
    } catch (err) {
      console.error("Lead lookup error:", err.message);
      return res.status(500).json({ error: "Failed to look up lead in Odoo." });
    }
  },
);

// Search partners in Odoo
app.get(
  "/pms/dashboard/search-partners",
  requireDashboardAuth,
  async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "Query must be at least 2 characters." });
    }

    try {
      const partners = await odooExecute(
        "res.partner",
        "search_read",
        [
          [
            ["name", "ilike", q.trim()],
            ["customer_rank", ">", 0],
          ],
        ],
        { fields: ["id", "name", "email", "phone"], limit: 20 },
      );
      return res.json({ partners });
    } catch (err) {
      console.error("Search partners error:", err.message);
      return res.status(500).json({ error: "Failed to search Odoo." });
    }
  },
);

// Search CRM leads/won opportunities in Odoo (for PMS triggering)
app.get(
  "/pms/dashboard/search-leads",
  requireDashboardAuth,
  async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res
        .status(400)
        .json({ error: "Query must be at least 2 characters." });
    }

    try {
      const leads = await odooExecute(
        "crm.lead",
        "search_read",
        [
          [
            ["partner_name", "ilike", q.trim()],
            ["type", "=", "opportunity"],
          ],
        ],
        {
          fields: [
            "id",
            "name",
            "partner_name",
            "partner_id",
            "email_from",
            "phone",
            "stage_id",
            "date_closed",
          ],
          limit: 20,
          order: "date_closed desc",
        },
      );
      return res.json({ leads });
    } catch (err) {
      console.error("Search leads error:", err.message);
      return res.status(500).json({ error: "Failed to search leads in Odoo." });
    }
  },
);

// List CRM leads that have a PMS questionnaire link generated
app.get(
  "/pms/dashboard/linked-leads",
  requireDashboardAuth,
  async (req, res) => {
    try {
      const leads = await odooExecute(
        "crm.lead",
        "search_read",
        [
          [
            ["x_pms_questionnaire_link", "!=", false],
            ["x_pms_questionnaire_link", "!=", ""],
          ],
        ],
        {
          fields: [
            "id",
            "name",
            "partner_name",
            "partner_id",
            "email_from",
            "stage_id",
            "x_pms_questionnaire_link",
          ],
          order: "id desc",
          limit: 200,
        },
      );
      return res.json({ leads });
    } catch (err) {
      console.error("Linked leads error:", err.message);
      return res.status(500).json({ error: "Failed to fetch leads." });
    }
  },
);

// List recently submitted PMS requests
app.get("/pms/dashboard/requests", requireDashboardAuth, async (req, res) => {
  const domain = [
    ["maintenance_type", "=", "preventive"],
    ["x_pms_submission_token", "!=", false],
  ];
  const customFields = [
    "x_pms_last_name",
    "x_pms_first_name",
    "x_pms_email",
    "x_pms_contact_number",
    "x_pms_site_address",
    "x_pms_preferred_time_slot",
    "x_pms_panel_location",
    "x_pms_has_issues",
    "x_pms_lead_id",
  ];
  const standardFields = [
    "id",
    "name",
    "request_date",
    "schedule_date",
    "stage_id",
  ];

  try {
    const requests = await odooExecute(
      "maintenance.request",
      "search_read",
      [domain],
      {
        fields: [...standardFields, ...customFields],
        order: "create_date desc",
        limit: 100,
      },
    );
    return res.json({ requests });
  } catch (err) {
    console.error("List requests error:", err.message);
    return res
      .status(500)
      .json({ error: "Failed to fetch maintenance requests." });
  }
});

// ─── Error page helper ────────────────────────────────────────────────────────

function buildErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Solviva Energy — PMS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    body { font-family: 'DM Sans', sans-serif; background: #F2F4F7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 12px; padding: 2.5rem 2rem; max-width: 480px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .logo { height: 48px; margin-bottom: 1.5rem; }
    h2 { color: #1f522b; margin-bottom: 0.75rem; font-size: 1.3rem; }
    p { color: #4b5563; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/pms/solvivalogo.png" alt="Solviva Energy" class="logo" />
    <h2>Notice</h2>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`PMS Questionnaire server running on port ${PORT}`);
});
