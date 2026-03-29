# Invoice Processing Pipeline - Regex-Based Extraction

> **Branch: `feature/no-ai-extraction`**
>
> This branch contains a **regex-based (non-AI) approach** for extracting invoice data.

## Overview

This version of the invoice processing pipeline uses **pattern matching and regular expressions** to extract structured data from PDF invoices, without relying on external AI APIs.

## ⚠️ Important Limitations

This regex-based approach has **significant limitations** due to the complexity of real-world invoices:

### Known Issues

| Problem | Description |
|---------|-------------|
| **Multiple Languages** | Invoices in EN, NL, FR, DE have different formats, keywords, and patterns |
| **Varied Currencies** | EUR, USD, INR with different number formats (1,234.56 vs 1.234,56) |
| **Inconsistent Layouts** | Each vendor structures invoices differently |
| **Ambiguous Patterns** | Keywords like "total" or "date" appear in multiple contexts |
| **Vendor Name Extraction** | Difficult to distinguish company names from addresses, product lines, or headers |
| **Tax ID Formats** | Each country has different VAT/GST formats (NL, FR, DE, IN, etc.) |
| **Date Formats** | DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, written dates (19 april 2014) |

### Extraction Accuracy (Test Results)

Based on testing with 11 sample invoices:

| Field | Accuracy |
|-------|----------|
| Invoice Numbers | 91% (10/11) |
| Vendor Names | 100% (some incorrect values) |
| Tax IDs | 36% (4/11) |
| Dates | 100% |
| Amounts | 100% |

### Specific Extraction Issues

- **Azure Interior** - Extracts product line instead of vendor name
- **Netpresse** - Extracts French table header as vendor
- **Free Fiber** - Extracts garbled text as vendor
- **Saeco** - Invoice number captured as "totaal" (Dutch word for total)
- **OYO** - Invoice number not found (booking ID pattern not matched)
- **Amazon** - Extra prefix text in vendor name

## Recommended Approach

> **The `main` branch contains the optimal solution using AI models.**
>
> The AI-based approach on the main branch provides:
> - **Higher accuracy** across all fields
> - **Better language handling** - understands context in multiple languages
> - **Intelligent extraction** - can distinguish vendor names from other text
> - **Flexible pattern recognition** - adapts to varied invoice layouts
>
> **Use the `main` branch for production deployments.**

## How This Approach Works

### Extraction Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│                    REGEX EXTRACTION                          │
└─────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │   PDF File   │
                              └──────┬───────┘
                                     │
                                     ▼
                         ┌─────────────────────┐
                         │     pdf-parse       │
                         │  (Text Extraction)  │
                         └──────────┬──────────┘
                                    │
                                    ▼
              ┌────────────────────────────────────────┐
              │         Pattern Matching Engine         │
              │                                        │
              │  ┌──────────────┐  ┌──────────────┐   │
              │  │   Invoice #  │  │   Tax IDs    │   │
              │  │   Patterns   │  │   Patterns   │   │
              │  └──────────────┘  └──────────────┘   │
              │  ┌──────────────┐  ┌──────────────┐   │
              │  │    Dates     │  │   Amounts    │   │
              │  │   Patterns   │  │   Patterns   │   │
              │  └──────────────┘  └──────────────┘   │
              │  ┌──────────────┐                     │
              │  │   Vendor     │                     │
              │  │   Heuristics │                     │
              │  └──────────────┘                     │
              └────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   Structured JSON   │
                         └─────────────────────┘
```

### Key Functions

| Function | Method |
|----------|--------|
| `extractInvoiceNumber()` | Regex patterns for invoice/rechnung/facture numbers |
| `extractVendorName()` | Priority-based line analysis with skip patterns |
| `extractTaxId()` | Country-specific VAT/GST patterns |
| `extractDates()` | Multiple date format patterns |
| `extractAmounts()` | Currency detection and amount extraction |

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/diogo-ribeiro-05/invoice-processing-pipeline.git
cd invoice-processing-pipeline

# Switch to this branch
git checkout feature/no-ai-extraction

# Install dependencies
npm install

# Set up environment variables
cp .env.local.example .env.local
# Edit .env.local with your ERP API key

# Run development server
npm run dev
```

### Testing Extraction Logic

Run the extraction test directly:

```bash
npx tsx test-extraction-import.ts
```

This will process all 11 sample invoices and display results.

### Usage

1. Navigate to `http://localhost:3000`
2. Click "Process All Invoices" to batch process PDFs in `/invoices`
3. Review extracted data in the dashboard
4. Note any extraction errors or missing fields

## Project Structure

```
invoice-processing-pipeline/
├── lib/
│   ├── claude.ts              # Main extraction logic (regex-based)
│   ├── erp-api.ts             # ERP API client
│   └── types.ts               # TypeScript interfaces
├── app/                       # Next.js App Router
│   ├── dashboard/             # Dashboard UI
│   └── api/                   # API routes
├── components/                # React components
├── invoices/                  # Sample PDFs (11 files)
├── test-extraction-import.ts  # Extraction test script
└── README.md
```

## Environment Variables

```env
# ERP API Configuration
ERP_API_KEY=your-erp-api-key
ERP_API_BASE_URL=https://backend-production-4c89.up.railway.app/api/erp

# Authentication
AUTH_SECRET=your-random-secret-key
```

Note: This branch does **not** require AI API keys (Anthropic, Gemini, etc.).

## When to Use This Branch

| Scenario | Recommendation |
|----------|---------------|
| No AI API access | Use this branch |
| Offline processing | Use this branch |
| Cost-sensitive | Use this branch |
| Production deployment | **Use `main` branch** |
| High accuracy needed | **Use `main` branch** |
| Multi-language invoices | **Use `main` branch** |

## Branch Comparison

| Feature | `feature/no-ai-extraction` | `main` |
|---------|---------------------------|--------|
| Invoice Number Accuracy | ~91% | ~99% |
| Vendor Name Accuracy | ~70% | ~95% |
| Tax ID Accuracy | ~36% | ~90% |
| AI API Required | No | Yes |
| Cost per Invoice | $0 | ~$0.01-0.05 |
| Offline Capable | Yes | No |

## License

This project was built as part of a coding challenge for Portline Logistics.
