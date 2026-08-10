# FBA Issue Monitor

**Chrome Extension for Automated Triage, Classification & Resolution of Seller Reimbursement Escalation SIMs**

Version: 1.11.1 | Platform: Chrome Manifest V3 | Internal Use Only

---

## Overview

FBA Issue Monitor is a Chrome extension that automates the triage workflow for the **Reimbursements India** team on Amazon's internal SIM (issues.amazon.com) ticketing system. It scans unassigned tickets every 5 minutes, classifies them into categories, validates mandatory fields, and either auto-resolves or auto-assigns them to the correct team member.

### What It Does

- **Scans** the unassigned queue every 5 minutes (or on-demand)
- **Classifies** each ticket into one of 15+ categories using keyword scoring
- **Validates** mandatory fields per category (MID, Order ID, FNSKU, etc.)
- **Auto-resolves** out-of-scope tickets (Fees/Weight/A-Z Claims) with redirect comments
- **Auto-resolves** wiki-not-followed tickets with format templates
- **Auto-assigns** valid tickets to the designated team member
- **EF Channel** (EasyShip/SellerFlex/MFN SAFE-T): Looks up Order IDs in uploaded SAFET data to determine Channel + Resolution Code, then assigns to the correct owner
- **Notifications**: Desktop alerts for new tickets, manual check required, etc.

---

## Architecture

```
+-------------------+     +----------------+     +------------------+
|   background.js   |<--->|  content.js    |<--->| issues.amazon.com|
| (Service Worker)  |     | (DOM Scraping) |     | (SIM Search Page)|
+-------------------+     +----------------+     +------------------+
        |
        v
+-------------------+     +----------------+
|   popup.js/html   |     |  rules.json    |
| (Dashboard UI)    |     | (Config/Rules) |
+-------------------+     +----------------+
        |
        v
+-------------------+
|  xlsx.min.js      |
| (SAFET Excel      |
|  Parser)          |
+-------------------+
```

### File Structure

| File | Purpose |
|------|---------|
| `manifest.json` | Extension configuration (MV3, permissions, content scripts) |
| `background.js` | Service worker: polling, classification, auto-mode orchestration |
| `content.js` | Content script: DOM scraping, UI automation on issues.amazon.com |
| `classifier.js` | Standalone classification engine (keyword scoring + field detection) |
| `rules.json` | All configuration: categories, keywords, field aliases, templates, mappings |
| `popup.html` | Extension popup HTML |
| `popup.js` | Popup logic: rendering, actions, SAFET Excel upload |
| `popup.css` | Popup styling |
| `xlsx.min.js` | SheetJS library for parsing Excel files |
| `yoda-content.js` | (Legacy) Yoda dashboard automation — no longer used |

---

## Categories & Classification

The classifier scores each ticket against defined categories using:
- **Primary ID regex** (+50 points): Pattern match for key identifiers
- **Exclusive keywords** (+15 points each): Strong signals unique to the category
- **General keywords** (+10 points each): Supporting signals
- **Field presence** (+5 points each): Mandatory field names found in text

### Priority Order (checked first to last):

1. **Weight/Dimension/Fees** → Out of Scope (score 999, immediate redirect)
2. **A-Z Claims** → Out of Scope (score 999, immediate redirect)
3. **EF Channel** (SAFE-T + channel keyword/title pattern) → SAFET lookup + assign
4. **Normal categories** (scored by keyword matching)

### Supported Categories

| Category | Assignee | Claim Window |
|----------|----------|--------------|
| Removal Lost (Not Delivered) | nitheraj | 30 days |
| Removal Lost (Delivered not received) | nitheraj | 7 days |
| Removal Damaged | nitheraj | 7 days |
| Removal Missing/Switcheroo | nitheraj | 15 days |
| Missing From Inbound (MFI) | vishancm | 60 days |
| Warehouse Lost | harikks | 60 days |
| Warehouse Damaged | harikks | 60 days |
| Order Related - Customer Damaged | ankiwkum | 45 days |
| Order Related - Lost in Transit | ankiwkum | 45 days |
| Order Related - Delivery Dispute/RTO | ankiwkum | 45 days |
| EF - SAFE-T Denial Dispute | (from SAFET data) | 45 days |
| EF - SAFE-T Unable to File | (from SAFET data) | 45 days |
| EF - SAFE-T Clawback | (from SAFET data) | 45 days |
| Weight/Dimension/Fees | — (auto-resolve) | — |
| A-Z Claims | — (auto-resolve) | — |

---

## EF Channel (External Fulfillment) Automation

For EasyShip, SellerFlex, and MFN SAFE-T escalation tickets:

### Flow
1. Ticket detected as EF (channel keyword + SAFE-T signal in title/body)
2. Mandatory fields checked (MID, Order ID, Reason Code, Yoda Dashboard, Deep Dive)
3. **SP-SEED Exception**: Only needs MID + Order IDs (skip other field checks)
4. Order IDs extracted from ticket body
5. Looked up in uploaded SAFET Excel data
6. Majority Channel + Final Resolution determined
7. Assigned to correct owner based on reason code mapping

### Reason Code → Assignee Mapping

| Resolution Code | Assignee |
|----------------|----------|
| Channel = MFN (any) | dhrubora |
| INSPECTED_FORWARD_LEG_INSPECTION_FAILED | dhrubora |
| INSPECTED_IMAGE_MISMATCH | bamulyao |
| SECURED_RETURN_RTS_IMAGES_MISMATCH | snshekar |
| SELLER_ABUSIVE_VERIFIED | snshekar |
| SELLER_ABUSIVE_VERIFIED_BLOCKED | snshekar |
| CTR (any pattern) | mansilko |
| RNOTR_SELLER_REFUSED_DISPOSED | khursheq |
| WINDOW_EXPIRED | snshekar |
| Re-evaluation | khursheq |
| Default / Other | mansilko |

### SAFET Data Upload
- Download daily SAFET Excel from SharePoint
- Click "Upload SAFET Excel" in popup
- Extension extracts Order ID, Channel, Final Resolution columns
- Stored locally for instant lookups (~40K rows)

---

## Auto-Mode

When enabled (toggle in popup), the extension runs fully autonomously:

1. Every 5 minutes, triggered by `chrome.alarms`
2. Checks system idle state (skips if locked)
3. Opens SIM search page, scrapes unassigned tickets
4. Validates scan quality (rejects if page didn't render properly)
5. For each ticket:
   - Fees/Weight → Auto-resolve with redirect comment
   - A-Z Claims → Auto-resolve with A-Z comment
   - EF Channel → Field check → SAFET lookup → Assign
   - Wiki Not Followed → Auto-resolve with format template
   - Classified + Fields Present → Auto-assign

### Safety Checks
- **Idle detection**: Won't scan when system is locked
- **Scan validation**: Rejects data if average description < 30 chars
- **No duplicate processing**: `autoProcessed` flag prevents re-processing

---

## Bucket Detection

When resolving a ticket, the extension scans the description for keywords to determine the correct "Bucket" for the resolve modal:

| Bucket | Detected When Text Contains |
|--------|----------------------------|
| Switcheroo | item switched, item swapped, different item, abuse |
| Lost in Transit | lost in transit, delivery attempted, tracking |
| MFI | shipment, carrier, challan, epod, short shipped |
| Removal Lost | removal missing, lost shipment, bluedart |
| Removal Damages | removal damaged, unboxing, disposition |
| Damages | damaged condition, refund, buyer, customer |
| Clawback Related Disputes | clawback, reimbursement deducted, clawed back |
| MFN | mfn, self-ship, disputing, delivery |
| Warehouse Lost | warehouse, reconciled, reconciliation |
| Re-evaluation | fmv, fair market value, less reimbursed |
| Warehouse Damaged | disposed warehouse, defective, warehouse damaged |

---

## Installation

1. Clone the repository
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked" → select the project folder
5. The extension icon appears in the toolbar

### First-Time Setup
1. Navigate to `issues.amazon.com` and log in
2. Open the extension popup → click "Scan Now"
3. Upload SAFET Excel file (for EF channel assignments)
4. Toggle "Auto Mode" when ready for autonomous operation

---

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Store findings, SAFET data, settings |
| `alarms` | 5-minute polling interval |
| `notifications` | Desktop alerts for new tickets, manual checks |
| `tabs` | Open/manage SIM tabs for scanning |
| `idle` | Detect locked screen to skip scans |
| `host_permissions: issues.amazon.com` | Content script injection for SIM automation |

---

## Configuration (rules.json)

All classification rules, templates, and mappings are in `rules.json`:

- `categories[]` — Category definitions with keywords, mandatory fields, sample formats
- `feesOverrideKeywords[]` — Keywords that trigger immediate Out of Scope
- `azClaimsKeywords[]` — Keywords that trigger A-Z Out of Scope
- `efChannelKeywords[]` — Keywords identifying EF channel tickets
- `efTitlePatterns[]` — Title patterns for EF classification
- `efReasonCodeMapping{}` — Resolution code → assignee mapping
- `bucketKeywords{}` — Keywords for resolve bucket detection
- `fieldAliases{}` — Alternative names for each mandatory field
- `outOfScopeCommentTemplate` — Comment for fees/weight redirect
- `azClaimsComment` — Comment for A-Z claims redirect
- `wikiNotFollowedCommentTemplate` — Template for missing fields
- `efWikiNotFollowedCommentTemplate` — Template for EF missing fields

---

## Key Metrics

| Metric | Value |
|--------|-------|
| Supported categories | 15+ |
| Field aliases | 200+ variations |
| Fees override keywords | 47 |
| Auto-resolve scenarios | 4 (Fees, A-Z, Wiki Not Followed, EF Wiki) |
| Auto-assign scenarios | 10+ (FBA categories + EF reason codes) |
| Scan interval | 5 minutes |
| SAFET data capacity | 40,000+ rows |

---

## Impact

- **Time saved**: ~2-3 minutes per ticket (manual triage) x 50+ tickets/day = ~2.5 hours/day
- **Accuracy**: Consistent classification based on defined rules (no human error in routing)
- **Coverage**: 24/7 monitoring (as long as Chrome is running)
- **Compliance**: Ensures wiki format is followed before assignment
- **Scalability**: Adding new categories/keywords requires only rules.json updates

---

## Future Enhancements

- [ ] Full Yoda dashboard automation (blocked by AWS QuickSight iframe sandboxing)
- [ ] Auto-detection of claim window expiry
- [ ] Dashboard/reporting for processed ticket metrics
- [ ] Multi-team support (configurable assignees per team)
- [ ] Slack/Chime notifications integration

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Scan shows wrong results | Clear findings, reload extension, rescan |
| Fields not detected | Check field aliases in rules.json, verify label format |
| Auto-mode not working | Check service worker console for errors |
| SAFET upload fails | Ensure file has "Order ID" and "Channel" columns |
| Extension not scanning | Verify issues.amazon.com tab is accessible |

---

## Team

- **Developer**: Singh (firewolf@amazon.com)
- **Team**: Reimbursements India, Seller Reimbursement

---

*This tool is for internal Amazon use only. It automates the manual triage process for the SR team, reducing processing time and ensuring consistent handling of escalation SIMs.*
