import Anthropic from '@anthropic-ai/sdk';
import pdf from 'pdf-parse';
import type { ExtractedData } from './types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.z.ai/api/anthropic',
});

const MODEL = process.env.ANTHROPIC_MODEL || 'glm-5';

const EXTRACTION_PROMPT = `You are an expert invoice data extraction system. Extract structured data from this invoice.

=== INPUT FORMAT ===
You are provided with both DIGITAL TEXT and OCR TEXT. Cross-reference them to build the final JSON:
- VENDOR NAMES and TAX IDs are often found in the OCR TEXT (extracted from image logos at the header or footers).
- TABULAR DATA, line items, and exact amounts are usually more accurate in the DIGITAL TEXT.
- PRIORITIZE OCR TEXT for company identity if it looks like a valid legal entity (with suffixes like B.V., Inc., GmbH, etc.).

=== CRITICAL: VENDOR NAME EXTRACTION ===
The VENDOR is the company ISSUING the invoice (the seller/biller).
The CUSTOMER is the company RECEIVING the invoice (the buyer).

STRICT RULES FOR VENDOR NAME:
1. POSITIONING: The Vendor name is typically the FIRST entity mentioned at the absolute top of the document (header). The Customer is usually listed further down, often under labels like "Bill To", "Factuuradres", "Sold To", or simply below the vendor's address. Do NOT extract the Customer as the Vendor.
2. NO REFERENCE CODES: Do not extract alphanumeric order IDs, customer numbers, or document IDs as the Vendor Name. Real company names usually contain natural words and often end with legal entity suffixes (Inc., B.V., Ltd., LLC, Corp., AG, etc.).
3. TABULAR DATA: Never extract the vendor name from data inside tables under columns like "Customer", "Klant", "Order", or "Client".
4. CONTEXTUAL CLUES: Watch for international proxy terms like "iov" or "i.o.v." (in opdracht van = on behalf of) which indicate the actual vendor entity.
5. SHIPPING/CONTACT PERSONS: Names located under "Bill To", "Ship To", "Factuuradres", "Afleveradres", or "Klant" are ALWAYS the CUSTOMER or CONTACT PERSON. NEVER extract them as the Vendor.
6. PLACEHOLDER NAMES: Ignore generic placeholder customer names (e.g., "YourCompany", "Your Company") or lowercase individual contact names - these are NOT the vendor.
7. TAGLINES & SLOGANS: Do not extract generic industry descriptions, taglines, or slogans (e.g., "Global Wholesaler", "Premium Services", "Logistics") as the Vendor Name. Look for the actual brand name.
8. STRICT CUSTOMER AVOIDANCE: Any entity located directly AFTER the word "Factuuradres" (Invoice Address) or directly BEFORE the word "T.a.v." (Ter attentie van) is the CUSTOMER. NEVER extract it. The vendor will be somewhere else (often at the very top or in the OCR TEXT footer).
9. OCR PRIORITY: If you find a brand name in the OCR TEXT (usually at the very top) and a different name in the DIGITAL TEXT recipient block, ALWAYS trust the OCR TEXT brand name as the Vendor.

=== TAX ID EXTRACTION ===
Look for labels: "VAT", "VAT/TIN", "BTW", "GSTIN", "Tax ID", "TVA", "VAT Number", "BTW-nr"
- The VENDOR's Tax ID is usually near the vendor's company name, footer, or issuer details.
- Labels like "Uw BTW nummer", "Your VAT", or "Customer VAT" indicate the CUSTOMER's tax ID. Do NOT extract these.
- Include country prefixes if present (e.g., FR, NL, DE, US).
- If no vendor tax ID is clearly identifiable, return null.

=== AMOUNT EXTRACTION ===
- Look for "Grand Total", "Total", "Totaal", "Factuur totaal" for the final amount.
- Subtotal is the amount BEFORE tax.
- Verify: subtotal + tax ≈ total.
- Do not include digits from product codes or row numbers.

=== INVOICE NUMBER ===
- Extract the EXACT full string including any letter prefixes, dashes, or slashes.
- Do NOT strip letters from the invoice number (e.g., "INV-2024-001" stays as-is, not "2024001").

=== LINE ITEMS ===
- Extract ALL rows from the items table, including those with a 0.00 price or discount lines.
- Do not skip any items regardless of their value.

=== REQUIRED JSON OUTPUT ===
Return ONLY a JSON object with these exact field names:
{
  "invoiceNumber": "string (exact value, do not strip prefixes)",
  "vendorName": "string",
  "vendorTaxId": "string or null",
  "issueDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD or null",
  "currency": "USD/EUR/INR/etc",
  "subtotal": number,
  "taxAmount": number or null,
  "totalAmount": number,
  "lineItems": [{"description": "string", "quantity": number, "unitPrice": number, "total": number}]
}

INVOICE TEXT:
`;

/**
 * Parse JSON from Claude response, handling markdown code blocks
 */
function parseJsonFromResponse(rawResponse: string): ExtractedData | null {
  try {
    let jsonStr = rawResponse.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();
    return JSON.parse(jsonStr) as ExtractedData;
  } catch {
    return null;
  }
}

/**
 * Calculate confidence based on required fields
 */
function calculateConfidence(data: ExtractedData | null): number {
  if (!data) return 0;
  const requiredFields = ['invoiceNumber', 'vendorName', 'totalAmount', 'currency'];
  const presentFields = requiredFields.filter(
    (field) =>
      data[field as keyof ExtractedData] !== null &&
      data[field as keyof ExtractedData] !== undefined &&
      data[field as keyof ExtractedData] !== ''
  );
  return presentFields.length / requiredFields.length;
}

/**
 * Extract text from PDF using OCR.space API
 * Uses modern Node.js Blob for true binary file upload (much safer than base64)
 * Returns empty string on failure to prevent pipeline crashes
 */
async function extractWithOcrSpace(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log('Starting OCR.space extraction...');

    // Use modern Node.js Blob for true binary file upload (much safer than base64)
    // Convert Buffer to Uint8Array for Blob compatibility
    const uint8Array = new Uint8Array(pdfBuffer);
    const blob = new Blob([uint8Array], { type: 'application/pdf' });
    const formData = new FormData();

    // Append as a file rather than a base64 string
    formData.append('file', blob, 'invoice.pdf');
    formData.append('apikey', 'helloworld');
    formData.append('OCREngine', '2'); // Engine 2 is better for PDFs
    // Note: Removed 'language: dut+eng' as forcing multiple languages can cause timeouts on the free tier.
    // Engine 2 auto-detects characters well enough for Tax IDs.

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      console.error('OCR.space API error:', response.status, response.statusText);
      return '';
    }

    const result = await response.json() as {
      ParsedResults?: Array<{ ParsedText?: string }>;
      ErrorMessage?: string;
    };

    if (result.ErrorMessage) {
      console.error('OCR.space error message:', result.ErrorMessage);
      return '';
    }

    const ocrText = result.ParsedResults?.[0]?.ParsedText || '';
    console.log('OCR.space extracted text length:', ocrText.length);

    return ocrText;
  } catch (error) {
    console.error('OCR.space extraction error:', error);
    return '';
  }
}

/**
 * Extract invoice data from PDF using concurrent text extraction + OCR
 * Runs pdf-parse and OCR.space in parallel, then merges results for LLM processing
 */
export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    // Step 1: Run digital text extraction and OCR concurrently
    console.log('Starting concurrent extraction (pdf-parse + OCR.space)...');

    const [pdfData, ocrText] = await Promise.all([
      pdf(pdfBuffer),
      extractWithOcrSpace(pdfBuffer),
    ]);

    const pdfText = pdfData.text;

    if (!pdfText || pdfText.trim().length === 0) {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text could be extracted from PDF',
      };
    }

    // Step 2: Merge results into combined text for LLM
    const combinedText = "--- DIGITAL TEXT ---\n" + pdfText +
                         "\n\n--- OCR TEXT ---\n" + ocrText;

    console.log('Combined text length:', combinedText.length);

    // Step 3: Process with LLM
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT + '\n\n' + combinedText + '\n\nReturn ONLY a valid JSON object with no additional text or markdown formatting.',
        },
      ],
    });

    // Extract text from response
    const textBlock = message.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text response from Claude',
      };
    }

    const rawResponse = textBlock.text;
    const extractedData = parseJsonFromResponse(rawResponse);

    if (!extractedData) {
      return {
        data: null,
        confidence: 0,
        rawResponse,
        error: 'Failed to parse JSON response',
      };
    }

    return {
      data: extractedData,
      confidence: calculateConfidence(extractedData),
      rawResponse,
    };
  } catch (error) {
    console.error('Claude extraction error:', error);
    return {
      data: null,
      confidence: 0,
      rawResponse: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function extractInvoiceDataWithRetry(
  pdfBuffer: Buffer,
  maxRetries: number = 2
): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await extractInvoiceData(pdfBuffer);

    if (result.data) {
      return result;
    }

    lastError = result.error;

    // Wait before retry (exponential backoff)
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  return {
    data: null,
    confidence: 0,
    rawResponse: '',
    error: lastError || 'Failed after retries',
  };
}
