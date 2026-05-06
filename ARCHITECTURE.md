# PMS Questionnaire — System Architecture

## 1. Overview

Clients due for their annual Preventive Maintenance Service (PMS) receive an email with a unique, secure questionnaire link. The client fills out a 4-section form covering site information, preferred schedule, access requirements, and system condition. On submission, a **`maintenance.request`** record is automatically created in Odoo with `maintenance_type = 'preventive'`.

---

## 2. System Components

```
┌─────────────────┐   Email w/ unique link   ┌──────────────────────┐
│  Odoo           │ ────────────────────────► │  Client Email Inbox  │
│  (res.partner)  │                           └──────────┬───────────┘
│                 │                                      │
└─────────────────┘                           client clicks link
                                                         │
                                                         ▼
                                          ┌──────────────────────────┐
                                          │  PMS Questionnaire       │
                                          │  Web App (Node.js)       │
                                          │  /pms?partner_id=X       │
                                          │  &token=HMAC_SHA256      │
                                          └──────────┬───────────────┘
                                                     │
                                          client fills 4 sections
                                          and clicks "Submit"
                                                     │
                                                     ▼
                                          ┌──────────────────────────┐
                                          │  POST /pms/api/submit    │
                                          │  1. Validate HMAC token  │
                                          │  2. Check no duplicate   │
                                          │  3. Validate dates       │
                                          │  4. Create maintenance   │
                                          │     .request in Odoo     │
                                          └──────────┬───────────────┘
                                                     │
                                                     ▼
                                          ┌──────────────────────────┐
                                          │  Odoo (Odoo.sh Prod)     │
                                          │  maintenance.request     │
                                          │  maintenance_type =      │
                                          │  'preventive'            │
                                          └──────────────────────────┘
```

---

## 3. URL Format & Token Security

- **Link format:** `https://your-domain.com/pms?partner_id={odoo_partner_id}&token={hmac_token}`
- **Token:** HMAC-SHA256 of `partner_id` signed with `HMAC_SECRET` (server-side secret)
- **Why HMAC:** Prevents URL guessing/tampering — token is unique per partner, cannot be forged without the secret
- **One-time use:** After a successful submission, re-opening the same link returns an "already submitted" message (deduplication via `x_pms_submission_token` field on `maintenance.request`)

---

## 4. Questionnaire Sections

### Section A — Client & Site Information

| Question                    | Required |
| --------------------------- | -------- |
| Last Name                   | ✓        |
| First Name                  | ✓        |
| Email Address               | ✓        |
| Contact Number              | ✓        |
| Site / Installation Address | ✓        |

### Section B — Preferred PMS Schedule

| Question                                             | Required |
| ---------------------------------------------------- | -------- |
| Preferred PMS Date (min 10 days from today)          | ✓        |
| Preferred Time Slot (Morning / Afternoon / Flexible) | ✓        |
| Alternative Date                                     | Optional |

### Section C — Site Access Requirements

| Question                                 | Required    |
| ---------------------------------------- | ----------- |
| Panel / Array Location                   | ✓           |
| Access Equipment Required (multi-select) | ✓           |
| Work Permit Required                     | ✓           |
| Work Permit Requirements (if yes)        | Conditional |
| Site Contact Person (if different)       | Optional    |
| Additional Access Instructions           | Optional    |

### Section D — System Condition & Concerns

| Question                     | Required    |
| ---------------------------- | ----------- |
| Any issues noticed recently? | ✓           |
| Issue description (if yes)   | Conditional |
| Other questions or requests  | Optional    |

---

## 5. Odoo — `maintenance.request` Field Mapping

### Standard Fields (no Studio needed)

| Odoo Field         | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| `name`             | `"PMS Request — {Last Name}, {First Name} ({Preferred Date})"` |
| `maintenance_type` | `"preventive"`                                                 |
| `request_date`     | Submission date (today)                                        |
| `schedule_date`    | Preferred date + time slot                                     |
| `description`      | Full human-readable questionnaire summary                      |

### Custom Fields (create via Odoo Studio on `maintenance.request`)

| Field Technical Name             | Type    | Label                    | Description                    |
| -------------------------------- | ------- | ------------------------ | ------------------------------ |
| `x_pms_last_name`                | Char    | Last Name                |                                |
| `x_pms_first_name`               | Char    | First Name               |                                |
| `x_pms_email`                    | Char    | Email                    |                                |
| `x_pms_contact_number`           | Char    | Contact Number           |                                |
| `x_pms_site_address`             | Text    | Site Address             |                                |
| `x_pms_preferred_date`           | Date    | Preferred PMS Date       |                                |
| `x_pms_preferred_time_slot`      | Char    | Time Slot                | morning / afternoon / flexible |
| `x_pms_alt_date`                 | Date    | Alternative Date         |                                |
| `x_pms_panel_location`           | Char    | Panel Location           |                                |
| `x_pms_access_equipment`         | Text    | Access Equipment         | Comma-separated list           |
| `x_pms_work_permit`              | Char    | Work Permit              |                                |
| `x_pms_work_permit_requirements` | Text    | Work Permit Requirements |                                |
| `x_pms_site_contact_name`        | Char    | Site Contact Name        |                                |
| `x_pms_site_contact_number`      | Char    | Site Contact Number      |                                |
| `x_pms_access_instructions`      | Text    | Access Instructions      |                                |
| `x_pms_has_issues`               | Boolean | Has Issues               |                                |
| `x_pms_issue_description`        | Text    | Issue Description        |                                |
| `x_pms_other_requests`           | Text    | Other Requests           |                                |
| `x_pms_partner_id`               | Integer | Partner ID               | Odoo res.partner ID            |
| `x_pms_submission_token`         | Char    | Submission Token         | For deduplication              |
| `x_pms_lead_id`                  | Integer | Lead ID                  | Optional link to crm.lead      |

> **Fallback behavior:** If custom fields don't exist yet in Odoo, the server falls back to creating the record with only standard fields (`name`, `maintenance_type`, `request_date`, `schedule_date`, `description`). All questionnaire data is always present in `description`.

---

## 6. API Endpoints

| Method | Path                                    | Auth           | Description                               |
| ------ | --------------------------------------- | -------------- | ----------------------------------------- |
| `GET`  | `/pms?partner_id=X&token=Y[&lead_id=Z]` | HMAC           | Serve questionnaire (validates token)     |
| `POST` | `/pms/api/submit`                       | HMAC (in body) | Submit questionnaire → create Odoo record |
| `GET`  | `/pms/dashboard`                        | —              | Dashboard HTML                            |
| `POST` | `/pms/dashboard/login`                  | Password       | Dashboard login → returns bearer token    |
| `POST` | `/pms/dashboard/generate-link`          | Bearer         | Generate unique link for a partner/lead   |
| `GET`  | `/pms/dashboard/search-partners?q=`     | Bearer         | Search Odoo partners by name              |
| `GET`  | `/pms/dashboard/search-leads?q=`        | Bearer         | Search CRM opportunities by partner name  |
| `GET`  | `/pms/dashboard/requests`               | Bearer         | List recent PMS submissions               |

---

## 7. Environment Variables

```
ODOO_URL=https://solviva-energy.odoo.com     # Odoo.sh prod URL
ODOO_DB=solviva-energy                        # Database name
ODOO_USER=your.email@aboitizpower.com         # Odoo user email
ODOO_API_KEY=your_odoo_api_key               # Odoo API key (Settings → Technical → API Keys)
HMAC_SECRET=<32+ random bytes hex>           # Used for link token generation
DASHBOARD_PASSWORD=<strong password>          # Dashboard login password
PORT=3001                                     # HTTP port
```

---

## 8. Deployment (Server running PriorityBooking)

Both PriorityBooking and PMS run as separate PM2 processes on the same server, reverse-proxied by Nginx (or equivalent).

```bash
# 1. On the server, clone/copy the PMS folder
cd /var/www
git clone https://github.com/your-org/PMS pms-questionnaire
cd pms-questionnaire

# 2. Install dependencies
npm install --omit=dev

# 3. Create .env from template
cp .env.example .env
nano .env   # Fill in Odoo credentials, HMAC_SECRET, DASHBOARD_PASSWORD

# 4. Create logs directory
mkdir -p logs

# 5. Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # Follow printed command to enable auto-start on reboot

# 6. Nginx — add location block to existing config
# location /pms {
#     proxy_pass http://127.0.0.1:3001;
#     proxy_http_version 1.1;
#     proxy_set_header Host $host;
#     proxy_set_header X-Real-IP $remote_addr;
#     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
#     proxy_set_header X-Forwarded-Proto $scheme;
# }
```

---

## 9. Odoo Studio — Create Custom Fields

1. In Odoo, go to **Settings → Technical → Fields** (or use Studio)
2. Model: `maintenance.request`
3. Create each `x_pms_*` field from the table in Section 5
4. Fields of type **Char**, **Text**, **Boolean**, **Integer**, and **Date**
5. No fields need to be marked as required in Odoo — validation is done on the web form

Alternatively, add custom fields via **Odoo Studio**:

- Open any Maintenance Request → click **Studio** icon
- Use "Add a field" for each custom field
- Studio automatically prefixes fields with `x_studio_` (update `server.js` if using Studio prefix)

> **Note on field prefix:** If using Odoo Studio, fields will be prefixed `x_studio_` instead of `x_`. Update the field names in `server.js` lines ~130–155 accordingly.

---

## 10. Workflow Integration

```
Aftersales Engr identifies client due for PMS (1-year mark)
    │
    ▼
Open PMS Dashboard (/pms/dashboard)
Search for client by name → select from results
Click "Generate Link" → copy the unique URL
    │
    ▼
Send link to client via email (Odoo mass mail or manual)
    │
    ▼
Client fills out questionnaire → clicks "Submit"
    │
    ▼
maintenance.request created in Odoo (stage: "New Request")
    │
    ▼
Aftersales Engr reviews in Odoo → proceeds with proposal workflow
```
