# Invoice Processing Pipeline

An intelligent invoice processing system built for Portline Logistics. This application automatically extracts structured data from invoice PDFs, validates vendor information against ERP records, and provides a dashboard for the finance team to review processed invoices.

## Overview

This system processes PDF invoices in multiple languages (English, Dutch, French, German) and currencies (USD, EUR, INR), using a **Primary/Secondary AI fallback architecture** to ensure reliability even when individual AI providers experience outages or rate limits.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 15 (App Router) with TypeScript |
| Styling | Tailwind CSS 4 |
| PDF Parsing | pdf-parse |
| Primary AI | Z.AI GLM-5 (via Anthropic SDK) |
| Fallback AI | Google Gemini 2.5 Flash |
| OCR | OCR.space API (for image-based PDFs) |
| Authentication | JWT with jose library |
| Deployment | Vercel (Serverless) |

## Architecture

### High-Level System Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           INVOICE PROCESSING PIPELINE                        │
└─────────────────────────────────────────────────────────────────────────────┘

                                    ┌──────────────┐
                                    │   PDF Upload │
                                    │  (Drag/Drop) │
                                    └──────┬───────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              PASS 1: Digital Extraction                       │
│  ┌─────────────────┐                                                         │
│  │   pdf-parse     │ ──► Extract embedded text from PDF                      │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    AI EXTRACTION (Fallback Chain)                    │    │
│  │  ┌───────────────────┐        ┌───────────────────┐                 │    │
│  │  │  PRIMARY: Z.AI    │ ─────► │  FALLBACK: Gemini │                 │    │
│  │  │  GLM-5 Model      │  fail  │  2.5 Flash        │                 │    │
│  │  │  (Anthropic SDK)  │        │  (Google AI SDK)  │                 │    │
│  │  └───────────────────┘        └───────────────────┘                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                         │
│  │  Structured JSON│ ──► { invoiceNumber, vendorName, vendorTaxId, ... }     │
│  └─────────────────┘                                                         │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        PASS 2: OCR Patch (Conditional)                        │
│                                                                              │
│  IF vendorName is placeholder OR vendorTaxId is missing:                     │
│  ┌─────────────────┐        ┌─────────────────┐                              │
│  │   OCR.space     │ ──►    │  AI Extraction  │ ──► Patch missing fields    │
│  │   (Image OCR)   │        │  (Fallback)     │                              │
│  └─────────────────┘        └─────────────────┘                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                       POST-PROCESSING: ERP Validation                         │
│                                                                              │
│  ┌─────────────────┐        ┌─────────────────┐                              │
│  │   Lookup Tax ID │ ──►    │  Match Company  │ ──► Update vendorName if    │
│  │   in ERP        │        │  in ERP         │     official name found     │
│  └─────────────────┘        └─────────────────┘                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              RESULT OUTPUT                                    │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ {                                                                    │   │
│  │   "invoiceNumber": "INV-2024-001",                                  │   │
│  │   "vendorName": "Coolblue B.V.",                                    │   │
│  │   "vendorTaxId": "NL810433941B01",                                  │   │
│  │   "issueDate": "2024-04-19",                                        │   │
│  │   "currency": "EUR",                                                │   │
│  │   "totalAmount": 717.97,                                            │   │
│  │   "lineItems": [...],                                               │   │
│  │   "confidenceScore": 1.0                                            │   │
│  │ }                                                                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### AI Provider Fallback Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        EXTRACTION REQUEST                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                  ┌─────────────────────────────────┐
                  │     PRIMARY: Z.AI (glm-5)       │
                  │     via Anthropic SDK           │
                  │                                 │
                  │  ✓ Fast response (~2-5s)        │
                  │  ✓ No rate limits               │
                  │  ✓ High accuracy                │
                  └────────────────┬────────────────┘
                                   │
                         ┌─────────┴─────────┐
                         │    Success?       │
                         └─────────┬─────────┘
                              │         │
                             YES        NO (401, 429, timeout, etc.)
                              │         │
                              │         ▼
                              │   ┌─────────────────────────────────┐
                              │   │  "Z.AI primary failed.          │
                              │   │   Falling back to Gemini..."    │
                              │   └────────────────┬────────────────┘
                              │                    │
                              │                    ▼
                              │   ┌─────────────────────────────────┐
                              │   │   SECONDARY: Gemini 2.5 Flash   │
                              │   │   via Google Generative AI SDK  │
                              │   │                                 │
                              │   │  ✓ JSON mime type forced        │
                              │   │  ✓ Safety filters disabled      │
                              │   │  ✓ Same prompt, same output     │
                              │   └────────────────┬────────────────┘
                              │                    │
                              └────────┬───────────┘
                                       │
                                       ▼
                              ┌────────────────┐
                              │  JSON Response │
                              │  (Same Schema) │
                              └────────────────┘
```

## Project Structure

```
invoice-processing-pipeline/
├── app/                              # Next.js App Router
│   ├── layout.tsx                    # Root layout with navigation
│   ├── page.tsx                      # Home (redirects to dashboard)
│   ├── globals.css                   # Global styles
│   ├── dashboard/
│   │   └── page.tsx                  # Main dashboard view
│   ├── login/
│   │   └── page.tsx                  # Login page
│   └── api/
│       ├── auth/
│       │   ├── login/route.ts        # Login endpoint
│       │   ├── logout/route.ts       # Logout endpoint
│       │   └── session/route.ts      # Session check
│       ├── upload/route.ts           # Handle PDF uploads (SSE streaming)
│       ├── process-all/route.ts      # Batch process all invoices
│       ├── process-invoice/route.ts  # Process single invoice
│       └── erp/
│           ├── companies/route.ts    # Fetch vendor companies
│           └── processed-invoices/
│               └── route.ts          # CRUD for processed invoices
├── components/
│   ├── StatsCard.tsx                 # Summary statistics cards
│   ├── InvoiceTable.tsx              # Invoice list with filtering
│   ├── InvoiceDetail.tsx             # Detailed invoice modal
│   ├── UploadArea.tsx                # Drag & drop upload with progress
│   └── ValidationBadge.tsx           # Match/Flagged status badge
├── lib/
│   ├── types.ts                      # TypeScript interfaces
│   ├── auth.ts                       # JWT authentication
│   ├── erp-api.ts                    # ERP API client & validation
│   └── claude.ts                     # AI extraction (Primary/Secondary)
├── invoices/                         # Sample invoice PDFs (11 files)
├── middleware.ts                     # Auth middleware protection
├── next.config.ts                    # Next.js configuration
├── tailwind.config.ts                # Tailwind configuration
├── vercel.json                       # Vercel deployment config
└── package.json
```

## Key Features

### 1. Intelligent PDF Processing

- **Digital Text Extraction**: Uses `pdf-parse` to extract embedded text
- **OCR Fallback**: Uses OCR.space for image-based/scanned PDFs
- **Two-Pass Architecture**:
  - Pass 1: Full extraction from digital text
  - Pass 2: Targeted OCR patch if vendor info is missing

### 2. AI Provider Fallback

| Provider | Role | When Used |
|----------|------|-----------|
| **Z.AI (GLM-5)** | Primary | Always tried first |
| **Gemini 2.5 Flash** | Fallback | When Z.AI fails (401, 429, timeout) |

Both providers use the **exact same prompt** to ensure consistent JSON output.

### 3. Vendor Validation

The system validates vendors against ERP records:

| Status | Description | Confidence |
|--------|-------------|------------|
| **Matched** | Both vendor name AND tax ID match ERP records | 100% |
| **Flagged** | Vendor matched but tax ID missing/mismatched | 50-85% |
| **Unknown** | Vendor not found in ERP company records | 50% |

### 4. Multi-Language Support

Handles invoices in:
- English (EN)
- Dutch (NL)
- French (FR)
- German (DE)

### 5. Real-Time Progress

- Server-Sent Events (SSE) for live progress updates
- Progress bar during batch processing
- Per-file status indicators

### 6. Authentication

- Cookie-based JWT authentication
- Protected routes via middleware
- 24-hour session expiry

## API Endpoints

### Internal API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Authenticate user |
| `/api/auth/logout` | POST | Clear session |
| `/api/auth/session` | GET | Check session status |
| `/api/upload` | POST | Upload and process PDFs (SSE streaming) |
| `/api/process-all` | POST | Process all invoices in `/invoices` directory |
| `/api/erp/companies` | GET | Fetch vendor companies from ERP |
| `/api/erp/processed-invoices` | GET | List all processed invoices |
| `/api/erp/processed-invoices` | POST | Submit processed invoice to ERP |
| `/api/erp/processed-invoices` | DELETE | Clear all processed invoices |

### External ERP API

- **Base URL**: `https://backend-production-4c89.up.railway.app/api/erp`
- **Authentication**: `X-ERP-API-Key` header

## Extracted Data Schema

```typescript
interface ExtractedData {
  invoiceNumber: string;      // Exact invoice number with prefixes
  vendorName: string;         // Company issuing the invoice
  vendorTaxId: string | null; // VAT/GST/Tax ID with country prefix
  issueDate: string;          // YYYY-MM-DD format
  dueDate: string | null;     // YYYY-MM-DD or null
  currency: string;           // 3-letter code (USD, EUR, INR)
  subtotal: number;           // Amount before tax
  taxAmount: number | null;   // Tax amount
  totalAmount: number;        // Final total
  lineItems: LineItem[];      // Array of line items
}

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}
```

## Environment Variables

```env
# ===========================================
# PRIMARY AI: Z.AI (Anthropic-compatible)
# ===========================================
ANTHROPIC_API_KEY=your-zai-api-key
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_MODEL=glm-5

# ===========================================
# SECONDARY AI: Google Gemini (Fallback)
# ===========================================
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash

# ===========================================
# ERP API Configuration
# ===========================================
ERP_API_KEY=your-erp-api-key
ERP_API_BASE_URL=https://backend-production-4c89.up.railway.app/api/erp

# ===========================================
# Authentication (Optional)
# ===========================================
AUTH_SECRET=your-random-secret-key
```

### Getting API Keys

| Provider | URL | Notes |
|----------|-----|-------|
| Z.AI | Contact provider | Anthropic-compatible API |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier: 150 req/day |
| ERP API | Provided by challenge | Pre-configured |

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

### Usage

1. Navigate to `http://localhost:3000/login`
2. Login with credentials (default: `admin` / `portline2024`)
3. **Option A**: Click "Process All Invoices" to batch process PDFs in `/invoices`
4. **Option B**: Drag & drop PDF files into the upload area
5. Review processed invoices in the dashboard
6. Filter by status (All, Matched, Flagged)
7. Click invoice row to view details

## Deployment

### Vercel (Recommended)

1. Connect the GitHub repository to Vercel
2. Configure environment variables in Vercel dashboard
3. Deploy automatically on push to `main`

### Environment Variables for Vercel

Add these in Vercel Dashboard → Settings → Environment Variables:

| Variable | Required |
|----------|----------|
| `ANTHROPIC_API_KEY` | Yes |
| `ANTHROPIC_BASE_URL` | Yes |
| `GEMINI_API_KEY` | Yes |
| `ERP_API_KEY` | Yes |
| `ERP_API_BASE_URL` | Yes |
| `AUTH_SECRET` | Recommended |

## Error Handling

### AI Provider Failures

1. **Primary (Z.AI) fails**: Automatically falls back to Gemini
2. **Both providers fail**: Returns error with retry suggestion
3. **Rate limits**: Logged with suggested retry delay

### JSON Parsing

- Handles markdown code blocks (```json ... ```)
- Multiple fallback extraction strategies
- Brace extraction for malformed responses
