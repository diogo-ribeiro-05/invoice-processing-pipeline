import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import pdf from 'pdf-parse';
import type { ExtractedData } from './types';
import { findCompanyByTaxId, isCompanyNameInText } from './erp-api';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Rate limit delay between API calls (6 seconds to stay under 10 req/min free tier)
const RATE_LIMIT_DELAY_MS = parseInt(process.env.GEMINI_RATE_LIMIT_MS || '6000', 10);

// Safety settings: Disable all content filtering to prevent false-positive blocks on invoice data
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * Main extraction prompt for digital text (Pass 1)
 * Extracts all invoice fields from digital PDF text
 */
const EXTRACTION_PROMPT = `You are an expert invoice data extraction system. Extract structured data from this invoice.

=== CRITICAL: VENDOR NAME EXTRACTION ===
The VENDOR is the company ISSUING the invoice (the seller/biller).
The CUSTOMER is the company RECEIVING the invoice (the buyer).

STRICT RULES FOR VENDOR NAME:
1. POSITIONING: The very first text at the top of the document is often the brand's logo text. Do NOT ignore short brand names (e.g., a single word) if they appear at the very top before any addresses. The Customer is usually listed further down, under labels like "Bill To", "Factuuradres", "Sold To", or simply below the vendor's address.
2. NO REFERENCE CODES: Do not extract alphanumeric order IDs, customer numbers, or document IDs as the Vendor Name. Real company names usually contain natural words and often end with legal entity suffixes (Inc., B.V., Ltd., LLC, Corp., AG, etc.).
3. TABULAR DATA: Never extract the vendor name from data inside tables under columns like "Customer", "Klant", "Order", or "Client".
4. PROXY BILLING: If you see a legal entity acting on behalf of a brand (e.g., indicated by "iov", "i.o.v.", "in opdracht van", or "on behalf of"), the VENDOR NAME should be the MAIN BRAND being represented, not the proxy legal entity. Look for the main brand name at the absolute top of the document.
5. SHIPPING/CONTACT PERSONS: Names located under "Bill To", "Ship To", "Factuuradres", "Afleveradres", or "Klant" are ALWAYS the CUSTOMER or CONTACT PERSON. NEVER extract them as the Vendor.
6. PLACEHOLDER NAMES: Ignore generic placeholder customer names (e.g., "YourCompany", "Your Company", "Strategic Corp", "bosd") or lowercase individual contact names - these are NOT the vendor.
7. TAGLINES & SLOGANS: Do not extract generic industry descriptions, taglines, or slogans (e.g., "Global Wholesaler", "Premium Services", "Logistics") as the Vendor Name. Look for the actual brand name.
8. STRICT CUSTOMER AVOIDANCE: Any entity located directly AFTER the word "Factuuradres" (Invoice Address) or directly BEFORE the word "T.a.v." (Ter attentie van) is the CUSTOMER. NEVER extract it. The vendor will be somewhere else (often at the very top).

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
Return ONLY a JSON object with these exact field names. Do NOT use markdown code blocks. Return raw JSON only:
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
 * Targeted prompt for OCR patch extraction (Pass 2)
 * Extracts ONLY vendorName and vendorTaxId from OCR text
 */
const OCR_PATCH_PROMPT = `You are extracting vendor information from OCR text scanned from an invoice image.

TASK: Extract ONLY the vendor name and vendor tax ID. Ignore everything else.

RULES FOR VENDOR NAME:
1. The vendor is at the TOP of the document (often a logo/brand name).
2. Short brand names are valid (e.g., a single word at the top).
3. PROXY BILLING: If you see "iov", "i.o.v.", "in opdracht van", or "on behalf of", extract the MAIN BRAND being represented, not the proxy legal entity.
4. Do NOT extract anything under "Factuuradres", "Bill To", "Ship To", "Klant", or "T.a.v." - those are customers.
5. Ignore generic placeholders like "YourCompany" or taglines like "Global Wholesaler".

RULES FOR TAX ID:
1. Look for: "VAT", "BTW", "BTW-nr", "VAT Number", "Tax ID".
2. Include country prefixes (e.g., NL, DE, FR).
3. Do NOT extract "Uw BTW nummer" or "Your VAT" - those are customer Tax IDs.
4. Return null if not found.

RETURN ONLY raw JSON (no markdown, no code blocks, no explanation):
{"vendorName": "string", "vendorTaxId": "string or null"}

OCR TEXT:
`;

/**
 * Call Gemini API to extract structured data
 * Includes JSON mime type enforcement and disabled safety filters
 */
async function callGemini(prompt: string): Promise<string> {
  const startTime = Date.now();
  console.log(`[Gemini] Calling model: ${MODEL}`);

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json', // Force JSON output
      },
      safetySettings: SAFETY_SETTINGS, // Disable content filtering
    });

    const response = result.response;
    const text = response.text();
    const duration = Date.now() - startTime;

    console.log(`[Gemini] Response received in ${duration}ms, length: ${text.length}`);

    // Log if prompt feedback was blocked
    if (response.promptFeedback?.blockReason) {
      console.warn(`[Gemini] Prompt blocked: ${response.promptFeedback.blockReason}`);
    }

    return text;
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Gemini] API error after ${duration}ms:`, error);

    // Detailed error logging for debugging
    if (error instanceof Error) {
      console.error(`[Gemini] Error message: ${error.message}`);
      console.error(`[Gemini] Error stack: ${error.stack?.split('\n').slice(0, 3).join('\n')}`);
    }

    throw error;
  }
}

/**
 * Robust JSON parser for Gemini responses
 * Handles multiple markdown formats and edge cases
 */
function parseJsonFromResponse(rawResponse: string): ExtractedData | null {
  try {
    let jsonStr = rawResponse.trim();

    // Robust markdown stripping - handle multiple variations
    jsonStr = jsonStr
      .replace(/```json\s*/gi, '')  // Remove ```json (case-insensitive)
      .replace(/```\s*/g, '')       // Remove ``` with any whitespace
      .replace(/^[^{]*/, '')        // Remove any text before the first {
      .replace(/[^}]*$/, '');       // Remove any text after the last }

    // If we stripped too much, try original approach
    if (!jsonStr.startsWith('{')) {
      jsonStr = rawResponse.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }
    }

    jsonStr = jsonStr.trim();

    // Try to find JSON object in the string
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as ExtractedData;
    console.log('[JSON Parser] Successfully parsed response');
    return parsed;
  } catch (parseError) {
    console.error('[JSON Parser] Failed to parse response');
    console.error('[JSON Parser] First 500 chars:', rawResponse.substring(0, 500));
    console.error('[JSON Parser] Parse error:', parseError instanceof Error ? parseError.message : parseError);

    // Try one more approach: extract everything between first { and last }
    try {
      const firstBrace = rawResponse.indexOf('{');
      const lastBrace = rawResponse.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const extracted = rawResponse.substring(firstBrace, lastBrace + 1);
        const parsed = JSON.parse(extracted) as ExtractedData;
        console.log('[JSON Parser] Recovered using brace extraction');
        return parsed;
      }
    } catch {
      console.error('[JSON Parser] Brace extraction also failed');
    }

    return null;
  }
}

/**
 * Parse the targeted OCR patch response (vendorName + vendorTaxId only)
 */
function parseOcrPatchResponse(rawResponse: string): { vendorName: string | null; vendorTaxId: string | null } | null {
  try {
    let jsonStr = rawResponse.trim();

    // Robust markdown stripping
    jsonStr = jsonStr
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    // Try to find JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    return {
      vendorName: parsed.vendorName || null,
      vendorTaxId: parsed.vendorTaxId || null,
    };
  } catch (parseError) {
    console.error('[JSON Parser] OCR patch parse failed:', parseError instanceof Error ? parseError.message : parseError);
    console.error('[JSON Parser] Raw response:', rawResponse.substring(0, 300));
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
 * Check if digital extraction needs OCR patching
 * Returns true if vendorName is missing/placeholder or vendorTaxId is missing
 */
function needsOcrPatch(data: ExtractedData | null): boolean {
  if (!data) return true;

  // Check if vendor name is missing or looks like a placeholder
  const vendorName = data.vendorName?.toLowerCase().trim() || '';
  const placeholderPatterns = [
    'your',
    'yourcompany',
    'strategic corp',
    'bosd',
    'unknown',
    'n/a',
    'placeholder',
  ];

  const isPlaceholder = !vendorName ||
                        vendorName.length < 2 ||
                        placeholderPatterns.some(p => vendorName.includes(p));

  // Check if tax ID is missing
  const missingTaxId = !data.vendorTaxId || data.vendorTaxId.trim() === '';

  return isPlaceholder || missingTaxId;
}

/**
 * Extract text from PDF using OCR.space API
 * Uses modern Node.js Blob for true binary file upload
 * Returns empty string on failure to prevent pipeline crashes
 */
async function extractWithOcrSpace(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log('Starting OCR.space extraction...');

    // Use modern Node.js Blob for true binary file upload
    // Convert Buffer to Uint8Array for Blob compatibility
    const uint8Array = new Uint8Array(pdfBuffer);
    const blob = new Blob([uint8Array], { type: 'application/pdf' });
    const formData = new FormData();

    // Append as a file rather than a base64 string
    formData.append('file', blob, 'invoice.pdf');
    formData.append('apikey', process.env.OCR_SPACE_API_KEY || 'helloworld');
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
 * Extract vendor info from OCR text using targeted prompt
 * Returns only vendorName and vendorTaxId
 */
async function extractVendorPatchFromOcr(ocrText: string): Promise<{ vendorName: string | null; vendorTaxId: string | null } | null> {
  try {
    console.log('Extracting vendor patch from OCR text...');

    const response = await callGemini(OCR_PATCH_PROMPT + '\n\n' + ocrText);

    const patch = parseOcrPatchResponse(response);
    if (patch) {
      console.log('OCR patch extracted:', patch);
    }
    return patch;
  } catch (error) {
    console.error('OCR patch extraction error:', error);
    return null;
  }
}

/**
 * Extract invoice data using Targeted Field Patching architecture
 *
 * PASS 1: Full digital extraction (pdf-parse → Gemini)
 * VALIDATION: Check if vendorName/vendorTaxId need patching
 * PASS 2: If needed, OCR → Gemini (vendor only) → patch original JSON
 * POST-PROCESSING: Validate vendor name against ERP using Tax ID
 * RETURN: Merged result with perfect financial data + patched vendor info
 */
export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    // ========================================
    // PASS 1: Full Digital Extraction
    // ========================================
    console.log('PASS 1: Starting digital text extraction...');

    const pdfData = await pdf(pdfBuffer);
    const pdfText = pdfData.text;

    if (!pdfText || pdfText.trim().length === 0) {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text could be extracted from PDF',
      };
    }

    console.log('Digital text length:', pdfText.length);

    // Send digital text to Gemini with full extraction prompt
    const fullPrompt = EXTRACTION_PROMPT + '\n\n' + pdfText + '\n\nReturn ONLY raw JSON with no markdown formatting or code blocks.';
    const rawResponse = await callGemini(fullPrompt);

    let extractedData = parseJsonFromResponse(rawResponse);

    if (!extractedData) {
      return {
        data: null,
        confidence: 0,
        rawResponse,
        error: 'Failed to parse JSON response',
      };
    }

    console.log('PASS 1 complete. Vendor:', extractedData.vendorName, 'Tax ID:', extractedData.vendorTaxId);

    // Track OCR text for combined search in post-processing
    let ocrText = '';

    // ========================================
    // VALIDATION: Check if OCR patch needed
    // ========================================
    if (needsOcrPatch(extractedData)) {
      // ========================================
      // PASS 2: Targeted OCR Patch
      // ========================================
      console.log('PASS 2: OCR patch needed - extracting from images...');

      ocrText = await extractWithOcrSpace(pdfBuffer);

      if (ocrText && ocrText.trim().length > 0) {
        // Extract ONLY vendorName and vendorTaxId from OCR text
        const vendorPatch = await extractVendorPatchFromOcr(ocrText);

        if (vendorPatch) {
          // Patch the original digital data with OCR vendor info
          if (vendorPatch.vendorName) {
            console.log('Patching vendorName:', extractedData.vendorName, '→', vendorPatch.vendorName);
            extractedData.vendorName = vendorPatch.vendorName;
          }
          if (vendorPatch.vendorTaxId) {
            console.log('Patching vendorTaxId:', extractedData.vendorTaxId, '→', vendorPatch.vendorTaxId);
            extractedData.vendorTaxId = vendorPatch.vendorTaxId;
          }
        }
      } else {
        console.log('OCR extraction failed or empty - keeping digital result');
      }

      console.log('PASS 2 complete. Vendor:', extractedData.vendorName, 'Tax ID:', extractedData.vendorTaxId);
    }

    // ========================================
    // POST-PROCESSING: ERP Vendor Name Validation
    // ========================================
    // Use Tax ID as source of truth to validate/correct vendor name
    if (extractedData.vendorTaxId) {
      console.log('POST-PROCESSING: Validating vendor name against ERP...');

      const erpCompany = await findCompanyByTaxId(extractedData.vendorTaxId);

      if (erpCompany) {
        console.log('ERP found company by Tax ID:', erpCompany.name);

        // Combine digital text AND OCR text for comprehensive search
        // The official company name might be in either source
        const combinedSearchText = pdfText + '\n' + ocrText;
        console.log('Searching in combined text (digital + OCR), total length:', combinedSearchText.length);

        // Check if the official ERP name appears in the combined text
        if (isCompanyNameInText(erpCompany.name, combinedSearchText)) {
          console.log('Official ERP name found in text - updating vendorName');
          console.log('Replacing:', extractedData.vendorName, '→', erpCompany.name);
          extractedData.vendorName = erpCompany.name;
        } else {
          console.log('Official ERP name NOT found in combined text - keeping extracted name');
        }
      } else {
        console.log('Tax ID not found in ERP - keeping extracted vendor name');
      }
    }

    console.log('Final Vendor:', extractedData.vendorName, 'Tax ID:', extractedData.vendorTaxId);

    return {
      data: extractedData,
      confidence: calculateConfidence(extractedData),
      rawResponse,
    };
  } catch (error) {
    console.error('Extraction error:', error);
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

/**
 * Rate limit delay for batch processing
 * Call this between invoice extractions to stay under Gemini free tier limits
 * Default: 6 seconds (10 requests per minute = 1 request per 6 seconds)
 */
export async function rateLimitDelay(): Promise<void> {
  console.log(`[Rate Limit] Waiting ${RATE_LIMIT_DELAY_MS}ms before next extraction...`);
  await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
}

// Export the delay value for logging
export const GEMINI_RATE_LIMIT_MS = RATE_LIMIT_DELAY_MS;
