# Invoice Processing Pipeline

An automated invoice processing system built for Portline Logistics. This application extracts structured data from invoice PDFs, validates vendor information against ERP records, and provides a dashboard for the finance team to review processed invoices.

## Objectives

- **Automate Data Extraction**: Extract structured invoice data (vendor name, tax ID, amounts, line items) from PDF documents
- **Vendor Validation**: Cross-reference extracted vendor information against ERP company records
- **Multi-language Support**: Handle invoices in English, Dutch, French, and German
- **Multi-currency Support**: Process invoices in USD, EUR, INR, and other currencies
- **Dashboard Interface**: Provide a user-friendly interface for finance teams to review processed invoices

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS 4 |
| PDF Processing | pdf-parse |
| AI/ML | GLM-5 via Z.AI API (Anthropic-compatible) |
| Deployment | Vercel |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Next.js Application                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │
│  │   /dashboard │    │ /api/process │    │  /api/erp/*  │         │
│  │  Review UI   │◄───│  Extract PDF │◄───│  ERP Proxy   │         │
│  └──────────────┘    └──────────────┘    └──────────────┘         │
│         │                   │                    │                  │
│         │                   ▼                    │                  │
│         │         ┌──────────────────┐          │                  │
│         │         │   pdf-parse      │          │                  │
│         │         │   (Text Extract) │          │                  │
│         │         └──────────────────┘          │                  │
│         │                   │                    │                  │
│         │                   ▼                    ▼                  │
│         │         ┌──────────────────────────────────┐             │
│         │         │         GLM-5 API (Z.AI)         │             │
│         │         │  Structured Data Extraction      │             │
│         │         └──────────────────────────────────┘             │
│         │                                        │                  │
│         └────────────────────────────────────────┘                  │
│                           │                                         │
│                           ▼                                         │
│              ┌──────────────────────────┐                          │
│              │      ERP API             │                          │
│              │  - GET /companies        │                          │
│              │  - POST /processed-inv   │                          │
│              │  - DELETE /processed-inv │                          │
│              └──────────────────────────┘                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
invoice-processing-pipeline/
├── app/
│   ├── layout.tsx                    # Root layout with navigation
│   ├── page.tsx                      # Home page (redirects to dashboard)
│   ├── dashboard/
│   │   └── page.tsx                  # Main dashboard view
│   └── api/
│       ├── process-invoice/
│       │   └── route.ts              # Process single PDF
│       ├── process-all/
│       │   └── route.ts              # Batch process all invoices
│       └── erp/
│           ├── companies/
│           │   └── route.ts          # Fetch companies from ERP
│           └── processed-invoices/
│               └── route.ts          # CRUD for processed invoices
├── components/
│   ├── StatsCard.tsx                 # Summary statistics card
│   ├── InvoiceTable.tsx              # Invoice list table
│   ├── InvoiceDetail.tsx             # Invoice detail modal/view
│   └── ValidationBadge.tsx           # Status badge component
├── lib/
│   ├── types.ts                      # TypeScript interfaces
│   ├── erp-api.ts                    # ERP API client & validation
│   └── claude.ts                     # AI extraction client
├── invoices/                         # Sample invoice PDFs
├── .env.local                        # Environment variables
├── next.config.ts
├── tailwind.config.ts
└── package.json
```

## Features

### PDF Processing Pipeline

1. **Text Extraction**: Uses `pdf-parse` to extract raw text from PDF documents
2. **AI Data Extraction**: Sends extracted text to GLM-5 for structured data extraction
3. **Confidence Scoring**: Calculates confidence based on presence of required fields

### Vendor Validation

The system validates vendors against ERP records with three possible outcomes:

| Status | Description |
|--------|-------------|
| **Matched** | Both vendor name and tax ID match ERP records |
| **Mismatched** | Vendor name matches but tax ID is missing or doesn't match |
| **Unknown** | Vendor not found in ERP company records |

Tax ID normalization handles format differences (spaces, dots, dashes).

### Dashboard

- **Summary Statistics**: Total invoices, matched vendors, flagged issues, total amount
- **Invoice Table**: Sortable list with status indicators
- **Filtering**: Filter by validation status
- **Detail View**: View extracted data and line items

## API Endpoints

### Internal API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/process-invoice` | POST | Process a single PDF file |
| `/api/process-all` | POST | Process all invoices in `/invoices` directory |
| `/api/erp/companies` | GET | Fetch vendor companies from ERP |
| `/api/erp/processed-invoices` | GET | List all processed invoices |
| `/api/erp/processed-invoices` | POST | Submit processed invoice |
| `/api/erp/processed-invoices` | DELETE | Clear all processed invoices |

### ERP API (External)

- **Base URL**: `https://backend-production-4c89.up.railway.app/api/erp`
- **Authentication**: `X-ERP-API-Key` header

## Environment Variables

```env
# AI API Configuration (Z.AI - Anthropic compatible)
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_MODEL=glm-5

# ERP API Configuration
ERP_API_KEY=your-erp-api-key
ERP_API_BASE_URL=https://backend-production-4c89.up.railway.app/api/erp
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/diogo-ribeiro-05/invoice-processing-pipeline.git
cd invoice-processing-pipeline

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys

# Run development server
npm run dev
```

### Processing Invoices

1. Place PDF invoices in the `/invoices` directory
2. Navigate to `http://localhost:3000/dashboard`
3. Click "Process All Invoices" to batch process
4. Review results in the dashboard

## Data Extraction Fields

The system extracts the following fields from each invoice:

| Field | Description |
|-------|-------------|
| `invoiceNumber` | Invoice/document number |
| `vendorName` | Company/vendor name |
| `vendorTaxId` | Tax ID (VAT, GST, etc.) |
| `issueDate` | Invoice date (YYYY-MM-DD) |
| `dueDate` | Payment due date |
| `currency` | 3-letter currency code |
| `subtotal` | Amount before tax |
| `taxAmount` | Tax amount |
| `totalAmount` | Total including tax |
| `lineItems` | Array of line items with description, quantity, unit price, total |

## Deployment

The application is configured for Vercel deployment:

1. Connect the GitHub repository to Vercel
2. Configure environment variables in Vercel dashboard
3. Deploy

## License

This project was built as part of a coding challenge for Portline Logistics.
