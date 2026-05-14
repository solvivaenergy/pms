/**
 * odoo-setup.js
 *
 * Run ONCE to:
 *   1. Inspect existing maintenance.request fields (shows any native CRM links)
 *   2. Create all custom x_pms_* fields (skips fields that already exist)
 *   3. Add a "PMS Questionnaire" tab to the maintenance.request form view
 *
 * Usage:
 *   node odoo-setup.js
 *
 * Requires a .env file with ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
 */

require("dotenv").config();
const axios = require("axios");

const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY } = process.env;

if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY) {
  console.error(
    "Missing required env vars: ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY",
  );
  process.exit(1);
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

async function odooRpc(service, method, args) {
  const res = await axios.post(
    `${ODOO_URL}/jsonrpc`,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "call",
      params: { service, method, args },
    },
    { timeout: 30000 },
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

let _uid = null;
async function getUid() {
  if (_uid) return _uid;
  _uid = await odooRpc("common", "authenticate", [
    ODOO_DB,
    ODOO_USER,
    ODOO_API_KEY,
    {},
  ]);
  if (!_uid)
    throw new Error(
      "Odoo authentication failed — check ODOO_USER and ODOO_API_KEY",
    );
  return _uid;
}

async function execute(model, method, args, kwargs = {}) {
  const uid = await getUid();
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Connecting to ${ODOO_URL} (db: ${ODOO_DB})...`);
  await getUid();
  console.log("✓ Authenticated\n");

  // ── Step 1: Find maintenance.request model ────────────────────────────────
  console.log("═══ Step 1: Checking maintenance.request model ═══");
  const [model] = await execute(
    "ir.model",
    "search_read",
    [[["model", "=", "maintenance.request"]]],
    { fields: ["id", "name"], limit: 1 },
  );
  if (!model)
    throw new Error(
      "maintenance.request model not found in this Odoo instance",
    );
  const modelId = model.id;
  console.log(`  maintenance.request  →  model id = ${modelId}`);

  // ── Step 2: Inspect existing fields ──────────────────────────────────────
  console.log("\n═══ Step 2: Existing fields on maintenance.request ═══");
  const allFields = await execute(
    "ir.model.fields",
    "search_read",
    [[["model_id", "=", modelId]]],
    {
      fields: ["name", "field_description", "ttype", "relation"],
      order: "name asc",
    },
  );
  const existingNames = new Set(allFields.map((f) => f.name));

  // Show any native CRM / partner / lead fields
  const relatedFields = allFields.filter((f) =>
    /lead|crm|partner|contact|sale|opportunity/i.test(
      f.name + f.field_description + (f.relation || ""),
    ),
  );
  if (relatedFields.length) {
    console.log("  Native CRM/partner-related fields found:");
    relatedFields.forEach((f) =>
      console.log(
        `    ${f.name.padEnd(35)} ${f.ttype.padEnd(12)} ${f.relation || ""}`,
      ),
    );
  } else {
    console.log(
      "  No native CRM/partner link fields found — will create x_pms_crm_lead_id (Many2one → crm.lead)",
    );
  }

  // Show existing x_pms_* fields
  const pmsFields = allFields.filter((f) => f.name.startsWith("x_pms_"));
  if (pmsFields.length) {
    console.log(`\n  Existing x_pms_* fields (${pmsFields.length}):`);
    pmsFields.forEach((f) =>
      console.log(
        `    ${f.name.padEnd(35)} ${f.ttype.padEnd(12)} ${f.field_description}`,
      ),
    );
  }

  // ── Step 3: Define all custom fields ─────────────────────────────────────
  console.log("\n═══ Step 3: Creating custom fields ═══");

  const fieldsToCreate = [
    // ── CRM link (Many2one — this is the proper Odoo relational link)
    {
      name: "x_pms_crm_lead_id",
      field_description: "CRM Lead",
      ttype: "many2one",
      relation: "crm.lead",
    },
    {
      name: "x_pms_partner_id",
      field_description: "Client (Partner)",
      ttype: "many2one",
      relation: "res.partner",
    },

    // ── Section A: Client & Site Information
    { name: "x_pms_last_name", field_description: "Last Name", ttype: "char" },
    {
      name: "x_pms_first_name",
      field_description: "First Name",
      ttype: "char",
    },
    { name: "x_pms_email", field_description: "Email (PMS)", ttype: "char" },
    {
      name: "x_pms_contact_number",
      field_description: "Contact Number",
      ttype: "char",
    },
    {
      name: "x_pms_site_address",
      field_description: "Site / Installation Address",
      ttype: "text",
    },

    // ── Section B: Preferred Schedule
    {
      name: "x_pms_preferred_date",
      field_description: "Preferred PMS Date",
      ttype: "date",
    },
    {
      name: "x_pms_preferred_time_slot",
      field_description: "Preferred Time Slot",
      ttype: "char",
    },
    {
      name: "x_pms_alt_date",
      field_description: "Alternative Date",
      ttype: "date",
    },

    // ── Section C: Site Access
    {
      name: "x_pms_panel_location",
      field_description: "Panel / Array Location",
      ttype: "char",
    },
    {
      name: "x_pms_access_equipment",
      field_description: "Access Equipment Required",
      ttype: "text",
    },
    {
      name: "x_pms_work_permit",
      field_description: "Work Permit Required",
      ttype: "char",
    },
    {
      name: "x_pms_work_permit_requirements",
      field_description: "Work Permit Requirements",
      ttype: "text",
    },
    {
      name: "x_pms_site_contact_name",
      field_description: "Site Contact Person",
      ttype: "char",
    },
    {
      name: "x_pms_site_contact_number",
      field_description: "Site Contact Number",
      ttype: "char",
    },
    {
      name: "x_pms_access_instructions",
      field_description: "Access Instructions",
      ttype: "text",
    },

    // ── Section D: System Condition
    {
      name: "x_pms_has_issues",
      field_description: "Issues Noticed Recently",
      ttype: "boolean",
    },
    {
      name: "x_pms_issue_description",
      field_description: "Issue Description",
      ttype: "text",
    },
    {
      name: "x_pms_other_requests",
      field_description: "Other Requests",
      ttype: "text",
    },

    // ── Internal / dedup
    {
      name: "x_pms_lead_id",
      field_description: "Lead ID (ref)",
      ttype: "integer",
    },
    {
      name: "x_pms_submission_token",
      field_description: "Submission Token",
      ttype: "char",
    },
  ];

  let created = 0,
    skipped = 0,
    errors = 0;
  for (const fieldDef of fieldsToCreate) {
    if (existingNames.has(fieldDef.name)) {
      console.log(`  SKIP    ${fieldDef.name}`);
      skipped++;
      continue;
    }
    try {
      const vals = {
        name: fieldDef.name,
        field_description: fieldDef.field_description,
        model_id: modelId,
        ttype: fieldDef.ttype,
        store: true,
        ...(fieldDef.relation ? { relation: fieldDef.relation } : {}),
      };
      const newId = await execute("ir.model.fields", "create", [vals]);
      console.log(`  CREATE  ${fieldDef.name.padEnd(40)} id=${newId}`);
      created++;
    } catch (err) {
      console.error(`  ERROR   ${fieldDef.name}: ${err.message}`);
      errors++;
    }
  }
  console.log(
    `\n  Fields: ${created} created, ${skipped} skipped, ${errors} errors`,
  );

  // ── Step 4: Find base maintenance.request form view ───────────────────────
  console.log("\n═══ Step 4: Finding maintenance.request form view ═══");
  const formViews = await execute(
    "ir.ui.view",
    "search_read",
    [
      [
        ["model", "=", "maintenance.request"],
        ["type", "=", "form"],
        ["inherit_id", "=", false],
      ],
    ],
    { fields: ["id", "name", "xml_id"], order: "priority asc", limit: 5 },
  );
  if (!formViews.length)
    throw new Error("No base form view found for maintenance.request");
  const baseView = formViews[0];
  console.log(
    `  Base view: "${baseView.name}"  id=${baseView.id}  xml_id=${baseView.xml_id || "(none)"}`,
  );
  if (formViews.length > 1) {
    console.log(`  (${formViews.length - 1} other base views ignored)`);
  }

  // ── Step 5: Build the PMS Questionnaire page XML ──────────────────────────
  const arch = `<data>
  <!-- CRM link fields on the main form body (always visible, before the notebook) -->
  <xpath expr="//notebook" position="before">
    <group string="CRM Link" name="pms_crm_link">
      <field name="x_pms_crm_lead_id" string="CRM Lead"/>
      <field name="x_pms_partner_id"  string="Client (Partner)"/>
    </group>
  </xpath>

  <!-- PMS Questionnaire tab — questionnaire data only -->
  <xpath expr="//notebook" position="inside">
    <page string="PMS Questionnaire" name="pms_questionnaire">

      <separator string="Section A — Client &amp; Site Information"/>
      <group>
        <group>
          <field name="x_pms_last_name"       string="Last Name"/>
          <field name="x_pms_first_name"      string="First Name"/>
          <field name="x_pms_email"           string="Email"/>
          <field name="x_pms_contact_number"  string="Contact Number"/>
        </group>
        <group>
          <field name="x_pms_site_address" string="Site / Installation Address" nolabel="0"/>
        </group>
      </group>

      <separator string="Section B — Preferred PMS Schedule"/>
      <group>
        <field name="x_pms_preferred_date"      string="Preferred Date"/>
        <field name="x_pms_preferred_time_slot" string="Preferred Time Slot"/>
        <field name="x_pms_alt_date"            string="Alternative Date"/>
      </group>

      <separator string="Section C — Site Access Requirements"/>
      <group>
        <group>
          <field name="x_pms_panel_location"   string="Panel / Array Location"/>
          <field name="x_pms_work_permit"      string="Work Permit Required"/>
          <field name="x_pms_site_contact_name"   string="Site Contact Person"/>
          <field name="x_pms_site_contact_number" string="Site Contact Number"/>
        </group>
        <group>
          <field name="x_pms_access_equipment"          string="Access Equipment Required"/>
          <field name="x_pms_work_permit_requirements"  string="Work Permit Requirements"/>
          <field name="x_pms_access_instructions"       string="Access Instructions"/>
        </group>
      </group>

      <separator string="Section D — System Condition &amp; Concerns"/>
      <group>
        <field name="x_pms_has_issues"        string="Issues Noticed Recently"/>
        <field name="x_pms_issue_description" string="Issue Description"/>
        <field name="x_pms_other_requests"    string="Other Requests"/>
      </group>

      <separator string="Internal"/>
      <group>
        <field name="x_pms_lead_id"           string="Lead ID (ref)"      readonly="1"/>
        <field name="x_pms_submission_token"  string="Submission Token"   readonly="1"/>
      </group>

    </page>
  </xpath>
</data>`;

  // ── Step 6: Create or update the inherited view ───────────────────────────
  console.log("\n═══ Step 6: Creating PMS Questionnaire view ═══");
  const PMS_VIEW_NAME = "maintenance.request.form.pms.questionnaire";

  const [existingView] = await execute(
    "ir.ui.view",
    "search_read",
    [[["name", "=", PMS_VIEW_NAME]]],
    { fields: ["id"], limit: 1 },
  );

  if (existingView) {
    await execute("ir.ui.view", "write", [[existingView.id], { arch }]);
    console.log(`  Updated existing view  id=${existingView.id}`);
  } else {
    const viewId = await execute("ir.ui.view", "create", [
      {
        name: PMS_VIEW_NAME,
        model: "maintenance.request",
        inherit_id: baseView.id,
        arch,
        priority: 99,
      },
    ]);
    console.log(`  Created new view  id=${viewId}`);
  }

  // ── Step 7: Add x_pms_questionnaire_link field to crm.lead ──────────────
  console.log("\n═══ Step 7: Adding PMS link field to crm.lead ═══");
  const [crmModel] = await execute(
    "ir.model",
    "search_read",
    [[["model", "=", "crm.lead"]]],
    { fields: ["id", "name"], limit: 1 },
  );
  if (!crmModel) {
    console.warn("  crm.lead model not found — skipping");
  } else {
    const crmFields = await execute(
      "ir.model.fields",
      "search_read",
      [
        [
          ["model_id", "=", crmModel.id],
          ["name", "=", "x_pms_questionnaire_link"],
        ],
      ],
      { fields: ["id", "name"], limit: 1 },
    );
    if (crmFields.length) {
      console.log(`  SKIP    x_pms_questionnaire_link (already exists)`);
    } else {
      const fieldId = await execute("ir.model.fields", "create", [
        {
          name: "x_pms_questionnaire_link",
          field_description: "PMS Questionnaire Link",
          model_id: crmModel.id,
          ttype: "char",
          store: true,
        },
      ]);
      console.log(
        `  CREATE  x_pms_questionnaire_link on crm.lead  id=${fieldId}`,
      );
    }

    // ── Step 8: Add PMS link field to the CRM lead form view ────────────────
    console.log("\n═══ Step 8: Adding PMS link to CRM lead form view ═══");
    const crmFormViews = await execute(
      "ir.ui.view",
      "search_read",
      [
        [
          ["model", "=", "crm.lead"],
          ["type", "=", "form"],
          ["inherit_id", "=", false],
        ],
      ],
      { fields: ["id", "name", "xml_id"], order: "priority asc", limit: 5 },
    );
    if (!crmFormViews.length) {
      console.warn("  No base CRM lead form view found — skipping");
    } else {
      const crmBaseView = crmFormViews[0];
      console.log(`  Base view: "${crmBaseView.name}"  id=${crmBaseView.id}`);

      const CRM_VIEW_NAME = "crm.lead.form.pms.link";
      const crmArch = `<data>
  <xpath expr="//sheet" position="before">
    <div class="alert alert-info" invisible="not x_pms_questionnaire_link" role="alert" style="margin-bottom:0">
      <strong>PMS Questionnaire Link:</strong>
      <field name="x_pms_questionnaire_link" widget="url" nolabel="1" style="margin-left:8px"/>
    </div>
  </xpath>
</data>`;

      const [existingCrmView] = await execute(
        "ir.ui.view",
        "search_read",
        [[["name", "=", CRM_VIEW_NAME]]],
        { fields: ["id"], limit: 1 },
      );
      if (existingCrmView) {
        await execute("ir.ui.view", "write", [
          [existingCrmView.id],
          { arch: crmArch },
        ]);
        console.log(`  Updated existing CRM view  id=${existingCrmView.id}`);
      } else {
        const crmViewId = await execute("ir.ui.view", "create", [
          {
            name: CRM_VIEW_NAME,
            model: "crm.lead",
            inherit_id: crmBaseView.id,
            arch: crmArch,
            priority: 99,
          },
        ]);
        console.log(`  Created new CRM view  id=${crmViewId}`);
      }
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Setup complete!

To verify:
  → Open Odoo → Maintenance app → any request → "PMS Questionnaire" tab
  → Open Odoo → CRM → Lead #1121 → blue banner at the top with the link
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
