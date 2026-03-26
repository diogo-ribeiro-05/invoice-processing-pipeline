import Anthropic from '@anthropic-ai/sdk';
import pdf from 'pdf-parse';
import type { ExtractedData } from './types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.z.ai/api/anthropic',
});

const MODEL = process.env.ANTHROPIC_MODEL || 'glm-5';

const EXTRACTION_PROMPT = `You are an expert invoice data extraction system. Extract structured data from this invoice text.

IMPORTANT INSTRUCTIONS:
1. Extract ALL available information from the invoice text below
2. Handle multiple languages (English, Dutch, French, German)
3. Handle multiple currencies (USD, EUR, INR, etc.)
4. If a field is not found, use null or empty string
5. For amounts, extract the numeric value only (no currency symbols)
6. For dates, use ISO 8601 format (YYYY-MM-DD)
7. Be precise with vendor names - extract the exact company name that issued the invoice
8. Look for the "from" or "seller" or "vendor" section to identify the company name

Extract the following fields:
- invoiceNumber: The invoice/document number
- vendorName: Full company/vendor name as shown (the company ISSUING the invoice, not receiving it)
- vendorTaxId: Tax ID (VAT number, GSTIN, etc.) - include the country prefix if present (e.g., "US-XXX", "DE-XXX", "NL-XXX")
- issueDate: Invoice/issue date in YYYY-MM-DD format
- dueDate: Payment due date in YYYY-MM-DD format (null if not present)
- currency: 3-letter currency code (USD, EUR, INR, etc.)
- subtotal: Amount before tax
- taxAmount: Tax amount (VAT, GST, etc.)
- totalAmount: Total amount including tax
- lineItems: Array of line items with description, quantity, unitPrice, and total

INVOICE TEXT:
`;

export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    // First extract text from PDF using pdf-parse
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

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: EXTRACTION_PROMPT + '\n\n' + pdfText + '\n\nReturn ONLY a valid JSON object with no additional text or markdown formatting.',
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

    // Parse JSON response
    // Handle potential markdown code blocks
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

    const extractedData = JSON.parse(jsonStr) as ExtractedData;

    // Calculate confidence based on required fields
    const requiredFields = ['invoiceNumber', 'vendorName', 'totalAmount', 'currency'];
    const presentFields = requiredFields.filter(
      (field) =>
        extractedData[field as keyof ExtractedData] !== null &&
        extractedData[field as keyof ExtractedData] !== undefined &&
        extractedData[field as keyof ExtractedData] !== ''
    );
    const confidence = presentFields.length / requiredFields.length;

    return {
      data: extractedData,
      confidence,
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
