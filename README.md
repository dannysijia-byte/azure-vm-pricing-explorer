# Azure VM Pricing Explorer

Compare 700+ Azure VM sizes with real-time pricing. No authentication required.

![Azure VM Pricing Explorer](https://img.shields.io/badge/Azure-VM%20Pricing-0078D4?style=flat-square&logo=microsoftazure)

## Features

- **No login required** — Uses the free public [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
- **Real-time pricing** — Pay-as-you-go, Spot, Reserved 1yr/3yr
- **15 currencies** — USD, EUR, GBP, JPY, KRW, and more
- **4 billing periods** — Hourly, daily, monthly, yearly
- **Dark/Light mode** — Persisted to localStorage
- **VM detail panel** — Click any VM to see specs + pricing across all regions
- **Smart specs parser** — Derives vCPUs, memory, architecture from VM names
- **Column visibility** — Show/hide 14+ columns
- **Export** — CSV and JSON export
- **Filters** — Search, family, vCPUs, memory, type, architecture
- **Regional comparison** — See which region offers the best price for each VM
- **Optional SSO** — Sign in with Microsoft for full capability data via Resource SKUs API

## Quick Start

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/azure-vm-pricing-explorer.git
cd azure-vm-pricing-explorer

# Install dependencies
npm install

# (Optional) Create config.js from template for SSO pre-fill
cp config.example.js config.js
# Edit config.js with your Azure identifiers

# Start the server
npm start

# Open http://localhost:3000
```

## How It Works

```
Browser ──GET──> localhost:3000/api/prices ──proxy──> prices.azure.com (free, no auth)
                                                          │
                                                    Retail Prices API
                                                    (public, no key needed)
```

The Node.js server acts as a lightweight proxy to avoid browser CORS restrictions when calling the Azure Retail Prices API.

## Architecture

| File | Description |
|---|---|
| `server.js` | Node.js backend — static file server + API proxy |
| `index.html` | Main page layout |
| `app.js` | Core application logic, filtering, sorting, rendering |
| `styles.css` | Full dark/light theme CSS |
| `vm-specs.js` | Smart VM name parser — derives specs from SKU names |
| `auth-sso.js` | Optional MSAL.js SSO module |
| `config.example.js` | Template for Azure credential pre-fill |

## Optional: Microsoft SSO

For full VM capability data (disk IOPS, NIC count, zones), you can optionally sign in:

1. Register an app in **Azure Portal → Entra ID → App registrations**
2. Add **SPA redirect URI**: `http://localhost:3000`
3. Add API permission: **Azure Service Management → user_impersonation**
4. Copy `config.example.js` → `config.js` and fill in your IDs

## Inspired By

- [CloudPrice.net](https://cloudprice.net) — Azure VM pricing comparison tool

## License

MIT
