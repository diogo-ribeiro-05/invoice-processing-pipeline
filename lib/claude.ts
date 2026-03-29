import pdf from 'pdf-parse';
import type { ExtractedData, LineItem } from './types';
import { findCompanyByTaxId, isCompanyNameInText } from './erp-api';

/**
 * Invoice Parser - No AI Required
 *
 * This module extracts structured data from invoice PDFs using regex patterns
 * and rule-based parsing. Supports multiple languages (EN, NL, DE, FR) and
 * currencies (EUR, USD, INR, etc.)
 */

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Normalize amount string to number
 */
function parseAmount(amountStr: string): number {
  if (!amountStr) return 0;

  let cleaned = amountStr.replace(/[€$₹£\s]/g, '');

  // Handle European format (1.234,56) vs US format (1,234.56)
  if (/\.\d{3},/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{3}\./.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (/,\d{2}$/.test(cleaned)) {
    cleaned = cleaned.replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse date string to YYYY-MM-DD format
 */
function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;

  // Try ISO format first
  const isoMatch = dateStr.match(/(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // European format DD-MM-YYYY or DD/MM/YYYY
  const euMatch = dateStr.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (euMatch) {
    const day = euMatch[1].padStart(2, '0');
    const month = euMatch[2].padStart(2, '0');
    return `${euMatch[3]}-${month}-${day}`;
  }

  // Named month format
  const months: Record<string, number> = {
    'jan': 1, 'januari': 1, 'janvier': 1, 'januar': 1,
    'feb': 2, 'februari': 2, 'février': 2, 'februar': 2,
    'mar': 3, 'maart': 3, 'mars': 3, 'märz': 3,
    'apr': 4, 'april': 4, 'avril': 4,
    'may': 5, 'mei': 5, 'mai': 5,
    'jun': 6, 'juni': 6, 'juin': 6,
    'jul': 7, 'juli': 7, 'juillet': 7,
    'aug': 8, 'augustus': 8, 'août': 8, 'august': 8,
    'sep': 9, 'september': 9, 'septembre': 9, 'sept': 9,
    'oct': 10, 'oktober': 10, 'octobre': 10, 'okt': 10,
    'nov': 11, 'november': 11, 'novembre': 11,
    'dec': 12, 'december': 12, 'décembre': 12, 'dez': 12, 'dezember': 12,
  };

  const lowerDate = dateStr.toLowerCase();
  for (const [monthName, monthNum] of Object.entries(months)) {
    if (lowerDate.includes(monthName)) {
      const dayMatch = dateStr.match(/(\d{1,2})/);
      const yearMatch = dateStr.match(/(\d{4})/);
      if (dayMatch && yearMatch) {
        const day = dayMatch[1].padStart(2, '0');
        const month = monthNum.toString().padStart(2, '0');
        return `${yearMatch[1]}-${month}-${day}`;
      }
    }
  }

  return null;
}

// ============================================
// EXTRACTION FUNCTIONS
// ============================================

// Helper: Check if value looks like a date
function looksLikeDate(value: string): boolean {
  // Match patterns like 8-9-2022, 03/20/2023, 2023-03-20
  if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(value)) return true;
  if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(value)) return true;
  return false;
}

// Helper: Check if value is an IBAN
function isIban(value: string): boolean {
  const clean = value.replace(/\s/g, '');
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean);
}

// Helper: Check if value is a Tax ID (VAT number)
function isTaxIdPattern(value: string): boolean {
  const clean = value.replace(/\s/g, '');
  return /^[A-Z]{2}\d{9,12}[A-Z0-9]{0,3}$/.test(clean);
}

/**
 * Extract invoice number
 */
function extractInvoiceNumber(text: string): string {
  const lines = text.split('\n');

  // Pattern: "# invoice_number_1" (literal hash followed by invoice number)
  for (const line of lines.slice(0, 30)) {
    const hashMatch = line.match(/^#\s*(invoice[_\w\d]+)$/i);
    if (hashMatch) return hashMatch[1];
  }

  // Pattern: "Invoice INV/2023/03/0008" or "Invoice #123"
  for (const line of lines.slice(0, 40)) {
    const invMatch = line.match(/^Invoice\s+([A-Z]{2,4}[\/\-]?\d{2,4}[\/\-]?\d{2,8})$/i);
    if (invMatch) return invMatch[1];
  }

  // Pattern: "Facture n°562044387" (French)
  for (const line of lines.slice(0, 40)) {
    const frMatch = line.match(/Facture\s*n[°º]\s*(\d{6,})/i);
    if (frMatch) return frMatch[1];
  }

  // Pattern: Number BEFORE label (PDF extraction quirk)
  // e.g., "993548900Factuurnummer:"
  for (const line of lines.slice(0, 40)) {
    const beforeLabelMatch = line.match(/(\d{6,})(?:Factuurnummer|Invoice Number|Rechnungsnr|Facture|nummer|number)/i);
    if (beforeLabelMatch) {
      const value = beforeLabelMatch[1];
      if (!looksLikeDate(value) && !isIban(value) && !isTaxIdPattern(value)) {
        return value;
      }
    }
  }

  // Pattern: Label followed by number (standard or no separator)
  // e.g., "Invoice Number:42183017"
  const labeledPatterns = [
    /(?:Invoice\s*Number|Invoice\s*No)[\s:#]*([A-Z0-9][\w\-\/]{4,25})/i,
    /(?:Factuur|Facture)\s*(?:nummer|n[°º])?[\s:#]*([A-Z0-9][\w\-\/]{4,25})/i,
    /(?:Rechnungsnr\.?|Kundenrn\.?)[\s:#]*([A-Z0-9][\w\-\/]{3,20})/i,
  ];

  for (const line of lines.slice(0, 40)) {
    for (const pattern of labeledPatterns) {
      const match = line.match(pattern);
      if (match && match[1]) {
        const value = match[1].trim().replace(/^#/, '').replace(/^:\s*/, '');
        if (value.length >= 4 && !looksLikeDate(value) && !isIban(value) && !isTaxIdPattern(value)) {
          if (!/^(total|sub|tax|vat|btw|date|datum)$/i.test(value)) {
            return value;
          }
        }
      }
    }
  }

  // Pattern: Label on one line, number on next
  // e.g., "Rechnungsnr.\n47774"
  for (let i = 0; i < Math.min(lines.length - 1, 40); i++) {
    const line = lines[i].trim();
    // Match "Rechnungsnr." or "Invoice Number" or similar at end of line
    if (/(?:Rechnungsnr|Invoice\s*No|Factuur|nummer)\.?\s*$/i.test(line)) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && /^\d{4,10}$/.test(nextLine)) {
        if (!looksLikeDate(nextLine)) {
          return nextLine;
        }
      }
    }
  }

  // Pattern: Contract Number fallback
  const contractMatch = text.match(/Contract\s*No\.?\s*[:\s]*([A-Z0-9]{5,15})/i);
  if (contractMatch) return contractMatch[1];

  // Pattern: Invoice format like INV-2024-001, FAC-123, SCONL000000444
  const formatPatterns = [
    /\b(SCO[A-Z]{0,2}\d{9,12})\b/gi,
    /\b(INV[\/\-]\d{4}[\/\-]\d{2,8})\b/gi,
    /\b(FAC[-]?\d{4,})\b/gi,
    /\b([A-Z]{2,3}\d{8,})\b/gi,
  ];

  for (const pattern of formatPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const value = match[1]?.trim();
      if (value && value.length >= 5 && value.length <= 30) {
        if (!looksLikeDate(value) && !isIban(value) && !isTaxIdPattern(value)) {
          return value;
        }
      }
    }
  }

  // Long numeric invoice numbers (8+ digits) near the top
  const topText = lines.slice(0, 40).join('\n');
  const numMatches = [...topText.matchAll(/\b(\d{8,12})\b/g)];
  for (const match of numMatches) {
    const value = match[1];
    if (!looksLikeDate(value) && !isIban(value) && !isTaxIdPattern(value)) {
      return value;
    }
  }

  return '';
}

/**
 * Extract tax ID (VAT/BTW/GSTIN)
 */
function extractTaxId(text: string): string | null {
  // PRIORITY 1: Dutch VAT with BXX suffix optionally followed by BTW (e.g., "NL810433941B01BTW")
  // NL VAT format: NL + 9 digits + B + 2 digits (e.g., NL810433941B01)
  const nlVatWithBtw = /\b(NL)(\d{9})(B\d{2})(?:BTW|TVA)?\b/gi;
  const nlMatches = [...text.matchAll(nlVatWithBtw)];
  for (const match of nlMatches) {
    const value = (match[1] + match[2] + match[3]).toUpperCase();
    if (value.length === 14) { // NL + 9 digits + B01 = 14 chars
      return value;
    }
  }

  // PRIORITY 2: Line-based labeled tax IDs (must be on same line!)
  const lines = text.split('\n');
  for (const line of lines) {
    // Skip lines that are clearly invoice number lines (not tax ID lines)
    if (/(?:Factuurnummer|Invoice\s*Number|Invoice\s*No|Rechnungsnr|Kundenrn)/i.test(line)) continue;
    if (/^\d{6,}(?:Factuurnummer|Invoice)/i.test(line)) continue;

    // Look for tax ID labels on this line
    if (/(?:VAT\s*(?:ID|Number|No)|BTW\s*(?:nummer|ID)|TVA\s*(?:intra|ID)|MwSt\s*(?:ID|Nummer)|GSTIN|GST\s*(?:ID|Number)|Uw\s*BTW\s*nummer|N°\s*de\s*TVA)/i.test(line)) {
      // Extract the tax ID from this line
      const taxIdMatch = line.match(/([A-Z]{0,2}\d{9,12}[A-Z0-9]{0,3})\b/i);
      if (taxIdMatch) {
        let value = taxIdMatch[1].replace(/\s+/g, '').toUpperCase();
        value = value.replace(/(BTW|TVA|MWST)$/i, '');
        if (value.length >= 10 && value.length <= 15) {
          return value;
        }
      }
    }
  }

  // PRIORITY 3: General EU VAT with country code prefix (but not on invoice number lines)
  const euVatPattern = /\b(NL|DE|FR|BE|ES|IT|AT|PT|LU|PL)\s*(\d{9,12})\s*([A-Z]{0,2}\d{0,2})\b/gi;
  const euMatches = [...text.matchAll(euVatPattern)];
  for (const match of euMatches) {
    const fullMatch = match[0];
    const country = match[1] || '';
    const numbers = match[2] || '';
    const suffix = match[3] || '';

    // Find the line containing this match
    const matchIndex = match.index || 0;
    const lineStart = text.lastIndexOf('\n', matchIndex);
    const lineEnd = text.indexOf('\n', matchIndex);
    const line = text.slice(Math.max(0, lineStart + 1), lineEnd > 0 ? lineEnd : undefined);

    // Skip if on an invoice number line
    if (/(?:Factuurnummer|Invoice\s*Number|Invoice\s*No|Rechnungsnr|Kundenrn)/i.test(line)) continue;

    // Skip if this looks like an IBAN (country code + 2 check digits + many alphanumeric)
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(fullMatch.replace(/\s/g, ''))) continue;

    const value = (country + numbers + suffix).replace(/\s/g, '').toUpperCase();
    // Valid VAT: 10-15 chars
    if (value.length >= 10 && value.length <= 15) {
      return value;
    }
  }

  // PRIORITY 4: French TVA format with spaces: FR 604 219 388 61
  const frTvaMatch = text.match(/N°\s*de\s*TVA[^:]*[:\s]+FR\s*(\d{3})\s*(\d{3})\s*(\d{3})\s*(\d{2})/i);
  if (frTvaMatch) {
    const value = 'FR' + frTvaMatch[1] + frTvaMatch[2] + frTvaMatch[3] + frTvaMatch[4];
    return value;
  }

  // PRIORITY 5: GSTIN (India) - 15 characters
  const gstinMatch = text.match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]Z[A-Z0-9])\b/i);
  if (gstinMatch) {
    return gstinMatch[1].toUpperCase();
  }

  return null;
}

/**
 * Extract vendor name from the top of the document
 */
function extractVendorName(text: string): string {
  const lines = text.split('\n');

  // Skip these words - they are not vendor names (lowercase matching)
  const skipWords = [
    'factuur', 'invoice', 'rechnung', 'facture', 'bill', 'credit', 'debit',
    'nummer', 'number', 'datum', 'date', 'page', 'pagina', 'blz',
    'total', 'totaal', 'subtotal', 'subtotaal', 'vat', 'btw', 'tax',
    'bedrag', 'amount', 'quantity', 'qty', 'aantal', 'price', 'prijs',
    'www', 'http', 'https', 'email', 'tel', 'fax', 'phone',
    'payment receipt', 'receipt', 'payment',
    'description', 'omschrijving', 'artikel',
    'klant', 'customer', 'bill to', 'ship to',
    'global wholesaler', 'your company', 'service provider',
  ];

  // Company suffix patterns - allow optional space and periods in B.V. and N.V.
  // Company suffix patterns - allow optional space in B.V. and N.V.
  // Use (?:\b|$) to allow matching at end of string or which "Coolblue B.V." matches
  const companySuffixes = /\b(inc|ltd|llc|corp|corporation|gmbh|ag|sa|bv|nv|co|b\. ?v\.|n\. ?v\.|pvt|limited|bvba|sprl|sas)(?:\b|$)/i;

  // Check if a line looks like a company name
  const looksLikeCompanyName = (line: string): { valid: boolean; priority: number } => {
    if (!line || line.length < 2 || line.length > 70) return { valid: false, priority: 0 };

    const trimmed = line.trim();
    const lowerLine = trimmed.toLowerCase();

    // Skip if it starts with or is a common invoice header word
    for (const word of skipWords) {
      if (lowerLine === word || lowerLine.startsWith(word + '.') || lowerLine.startsWith(word + ' ')) {
        return { valid: false, priority: 0 };
      }
    }

    // Skip tax IDs and VAT numbers (e.g., NL810433941B01BTW)
    if (/^[A-Z]{2}\d{9,12}[A-Z0-9]{0,4}$/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i.test(trimmed)) return { valid: false, priority: 0 }; // IBAN
    if (/^(NL|DE|FR|BE|ES|IT)\d{9,12}/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip BIC/SWIFT codes (8 or 11 characters: 4 letters bank + 2 country + 2 location + optional 3 branch)
    if (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(trimmed)) return { valid: false, priority: 0 };

    // Skip postal codes + cities (e.g., "69100 VILLEURBANNE")
    if (/^\d{4,5}\s+[A-Z]{2,}$/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/^\d{4}\s*[A-Z]{2}\s/i.test(trimmed)) return { valid: false, priority: 0 }; // Dutch postal code

    // Skip pure numbers
    if (/^\d+$/.test(trimmed)) return { valid: false, priority: 0 };

    // Skip dates
    if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(trimmed)) return { valid: false, priority: 0 };
    if (/^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(trimmed)) return { valid: false, priority: 0 };

    // Skip addresses
    if (/^(street|straat|weg|laan|road|avenue|place|plaza|lane|drive|rue)/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/^(postcode|zip|po box|postbus)/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/^\d{4}\s*[A-Z]{2}/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/^\d+\s+(street|straat|road|ave|lane|rue)/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip contact info
    if (/^(tel|phone|fax|email|www|http|web|mobiel|mobile|\()/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines that are all lowercase (probably not company names)
    if (/^[a-z\s\d\.,]+$/.test(trimmed)) return { valid: false, priority: 0 };

    // Skip header table rows
    if (/description.*quantity.*price/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/artikel.*omschrijving.*prijs/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines that look like bank details
    if (/^(IBAN|BIC|SWIFT|Kto-Nr|Blz|Bank)/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines starting with "au capital" (French company legal text)
    if (/^au capital/i.test(trimmed)) return { valid: false, priority: 0 };
    if (/−\s*B\s*\d+.*RCS/i.test(trimmed)) return { valid: false, priority: 0 }; // French company registration

    // Skip product lines with SKU codes in brackets (e.g., "[17589684]")
    if (/^\[?\s*\d{6,}\]?/.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines that look like product lines with measurements
    if (/^\d+\s*(x\s*)?(kg|g|ml|l|pcs|st|ct|lb|oz|fl|ea)\b/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines that look like "sold by" sentences
    if (/^sold by\s+/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines with "service" and subscription-related suffixes (like "Service Abonn", "Services Pvt")
    if (/\bservice\s+(abonn|subscri|support)/i.test(trimmed)) return { valid: false, priority: 0 };

    // Skip lines that look like customer reference numbers (Numéro de dossier)
    if (/^(numéro|numero)\s+de\s+dossier/i.test(trimmed)) return { valid: false, priority: 0 };

    // Calculate priority
    let priority = 1;
    if (companySuffixes.test(trimmed)) priority = 3; // Highest priority for company suffixes
    else if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+/.test(trimmed)) priority = 2; // Title Case
    else if (/[A-Z]{2,}/.test(trimmed)) priority = 2; // Contains acronyms

    return { valid: true, priority };
  };

  // Collect candidates with priorities
  const candidates: { name: string; priority: number; index: number }[] = [];

  for (let i = 0; i < Math.min(40, lines.length); i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const { valid, priority } = looksLikeCompanyName(line);
    if (!valid) continue;

    // Clean up the name
    let name = line
      .replace(/[^\w\s\.\-&,']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    name = name.replace(/\s+\d+$/g, '').trim();

    if (name.length >= 2 && name.length <= 60) {
      candidates.push({ name, priority, index: i });
    }
  }

  // Sort by priority (higher first), then by position (earlier first)
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.index - b.index;
  });

  // Return the highest priority candidate
  if (candidates.length > 0) {
    return candidates[0].name;
  }

  return 'Unknown Vendor';
}

/**
 * Extract currency
 */
function extractCurrency(text: string): string {
  if (/€/.test(text)) return 'EUR';
  if (/₹/.test(text)) return 'INR';
  if (/£/.test(text)) return 'GBP';
  if (/\$\s*[\d]/.test(text)) return 'USD';

  // Language hints
  if (/btw|totaal|factuur/i.test(text)) return 'EUR';
  if (/mwst|rechnung|betrag/i.test(text)) return 'EUR';
  if (/tva|facture|montant/i.test(text)) return 'EUR';
  if (/gst|₹/i.test(text)) return 'INR';

  return 'USD';
}

/**
 * Extract amounts (total, subtotal, tax)
 */
function extractAmounts(text: string): { total: number; subtotal: number; tax: number } {
  let total = 0;
  let subtotal = 0;
  let tax = 0;

  // Find total amount - look for the largest amount near "total" keyword
  const totalPatterns = [
    /(?:total|totaal|gesamtbetrag|montant total|grand total|factuur totaal|end total|amount due)[^€$₹£\d]*(?:[€$₹£]?\s*([\d,.]+))/gi,
    /(?:totaal|total)\s*(?:bedrag|amount)?[^€$₹£\d]*([€$₹£]?\s*[\d,.]+)/gi,
  ];

  for (const pattern of totalPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const amount = parseAmount(match[1]);
      if (amount > total) {
        total = amount;
      }
    }
  }

  // Find subtotal
  const subtotalPatterns = [
    /(?:subtotal|subtotaal|zwischen-summe|sous-total|nett|netto)[^€$₹£\d]*([€$₹£]?\s*[\d,.]+)/gi,
  ];

  for (const pattern of subtotalPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const amount = parseAmount(match[1]);
      if (amount > subtotal) {
        subtotal = amount;
      }
    }
  }

  // Find tax
  const taxPatterns = [
    /(?:vat|btw|mwst|tva|tax|gst)[^€$₹£\d]*([€$₹£]?\s*[\d,.]+)/gi,
    /(?:btw|vat)\s*\(?[\d.]+%?\)?[^€$₹£\d]*([€$₹£]?\s*[\d,.]+)/gi,
  ];

  for (const pattern of taxPatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const amount = parseAmount(match[1]);
      if (amount > 0 && (total === 0 || amount < total)) {
        tax = Math.max(tax, amount);
      }
    }
  }

  // If no total found, find the largest standalone amount
  if (total === 0) {
    const allAmounts = [...text.matchAll(/[€$₹£]?\s*([\d,.]+)/g)];
    for (const match of allAmounts) {
      const amount = parseAmount(match[1]);
      if (amount > total) {
        total = amount;
      }
    }
  }

  // Calculate missing values
  if (subtotal === 0 && total > 0) {
    subtotal = tax > 0 ? total - tax : total;
  }
  if (tax === 0 && subtotal > 0 && total > subtotal) {
    tax = total - subtotal;
  }

  return {
    total: Math.round(total * 100) / 100,
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100
  };
}

/**
 * Extract dates
 */
function extractDates(text: string): { issueDate: string | null; dueDate: string | null } {
  let issueDate: string | null = null;
  let dueDate: string | null = null;

  // Issue date patterns
  const issuePatterns = [
    /(?:invoice|factuur|rechnung|facture)\s*(?:date|datum)?[^:]*[:\s]+([^\n]+)/gi,
    /(?:date|datum)\s*[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/gi,
    /(?:date|datum)\s*[:\s]+(\d{4}[-\/]\d{2}[-\/]\d{2})/gi,
  ];

  outer:
  for (const pattern of issuePatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const parsed = parseDate(match[1] || match[0]);
      if (parsed) {
        issueDate = parsed;
        break outer;
      }
    }
  }

  // Due date patterns
  const duePatterns = [
    /(?:due|payment|verval|fälligkeit|échéance)\s*(?:date|datum)?[^:]*[:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/gi,
    /(?:due|payment|verval|fälligkeit|échéance)\s*(?:date|datum)?[^:]*[:\s]+(\d{4}[-\/]\d{2}[-\/]\d{2})/gi,
  ];

  outer2:
  for (const pattern of duePatterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      const parsed = parseDate(match[1] || match[0]);
      if (parsed && parsed !== issueDate) {
        dueDate = parsed;
        break outer2;
      }
    }
  }

  // Fallback: find first date in document
  if (!issueDate) {
    const dateMatch = text.match(/(\d{4}[-\/]\d{2}[-\/]\d{2})|(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/);
    if (dateMatch) {
      issueDate = parseDate(dateMatch[0]);
    }
  }

  return { issueDate, dueDate };
}

/**
 * Extract line items (simplified)
 */
function extractLineItems(text: string): LineItem[] {
  const items: LineItem[] = [];

  // Simple approach: find product-like lines with prices
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.trim() || line.length < 10) continue;

    // Skip header lines
    if (/^(item|description|qty|price|total|product|artikel)/i.test(line)) continue;

    // Pattern: text followed by amount
    const match = line.match(/^(.+?)\s{2,}[\$€£₹]?([\d,.]+)\s*$/);
    if (match && match[1] && match[2]) {
      const description = match[1].trim();
      const total = parseAmount(match[2]);

      if (description.length > 3 && total > 0) {
        items.push({
          description,
          quantity: 1,
          unitPrice: total,
          total,
        });
      }
    }
  }

  return items.slice(0, 20); // Limit to 20 items
}

/**
 * Extract text from PDF using OCR.space API
 */
async function extractWithOcrSpace(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log('[OCR] Starting OCR.space extraction...');

    const uint8Array = new Uint8Array(pdfBuffer);
    const blob = new Blob([uint8Array], { type: 'application/pdf' });
    const formData = new FormData();

    formData.append('file', blob, 'invoice.pdf');
    formData.append('apikey', process.env.OCR_SPACE_API_KEY || 'helloworld');
    formData.append('OCREngine', '2');

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      console.error('[OCR] API error:', response.status);
      return '';
    }

    const result = await response.json() as {
      ParsedResults?: Array<{ ParsedText?: string }>;
      ErrorMessage?: string;
    };

    if (result.ErrorMessage) {
      console.error('[OCR] Error:', result.ErrorMessage);
      return '';
    }

    const ocrText = result.ParsedResults?.[0]?.ParsedText || '';
    console.log('[OCR] Extracted text length:', ocrText.length);

    return ocrText;
  } catch (error) {
    console.error('[OCR] Extraction error:', error);
    return '';
  }
}

/**
 * Main extraction function - No AI Required
 */
export async function extractInvoiceData(pdfBuffer: Buffer): Promise<{
  data: ExtractedData | null;
  confidence: number;
  rawResponse: string;
  error?: string;
}> {
  try {
    console.log('[Extraction] Starting non-AI extraction...');

    // Extract text from PDF
    const pdfData = await pdf(pdfBuffer);
    let pdfText = pdfData.text;

    if (!pdfText || pdfText.trim().length < 50) {
      console.log('[Extraction] PDF text too short, trying OCR...');
      const ocrText = await extractWithOcrSpace(pdfBuffer);
      if (ocrText.length > pdfText.length) {
        pdfText = ocrText;
      }
    }

    if (!pdfText || pdfText.trim().length === 0) {
      return {
        data: null,
        confidence: 0,
        rawResponse: '',
        error: 'No text could be extracted from PDF',
      };
    }

    console.log('[Extraction] Text length:', pdfText.length);

    // Get OCR text for additional validation
    const ocrText = pdfText.length < 500 ? await extractWithOcrSpace(pdfBuffer) : '';

    // Extract all fields
    const invoiceNumber = extractInvoiceNumber(pdfText);
    const vendorName = extractVendorName(pdfText);
    const vendorTaxId = extractTaxId(pdfText + '\n' + ocrText);
    const { issueDate, dueDate } = extractDates(pdfText);
    const currency = extractCurrency(pdfText);
    const { total, subtotal, tax } = extractAmounts(pdfText);
    const lineItems = extractLineItems(pdfText);

    // Build result
    const extractedData: ExtractedData = {
      invoiceNumber,
      vendorName,
      vendorTaxId: vendorTaxId || '',
      issueDate: issueDate || new Date().toISOString().split('T')[0],
      dueDate,
      currency,
      subtotal,
      taxAmount: tax,
      totalAmount: total,
      lineItems,
    };

    // Calculate confidence
    let confidence = 0;
    if (extractedData.invoiceNumber && extractedData.invoiceNumber.length >= 4) confidence += 0.25;
    if (extractedData.vendorName && extractedData.vendorName !== 'Unknown Vendor') confidence += 0.25;
    if (extractedData.totalAmount > 0) confidence += 0.25;
    if (extractedData.currency) confidence += 0.15;
    if (extractedData.vendorTaxId) confidence += 0.10;

    console.log('[Extraction] Complete. Confidence:', confidence.toFixed(2));
    console.log('[Extraction] Vendor:', extractedData.vendorName);
    console.log('[Extraction] Invoice #:', extractedData.invoiceNumber);
    console.log('[Extraction] Tax ID:', extractedData.vendorTaxId || 'N/A');
    console.log('[Extraction] Total:', extractedData.totalAmount, extractedData.currency);

    // Post-processing: ERP validation
    if (extractedData.vendorTaxId) {
      console.log('[Extraction] Validating against ERP...');
      const erpCompany = await findCompanyByTaxId(extractedData.vendorTaxId);

      if (erpCompany) {
        console.log('[Extraction] ERP match:', erpCompany.name);
        const combinedText = pdfText + '\n' + ocrText;

        if (isCompanyNameInText(erpCompany.name, combinedText)) {
          console.log('[Extraction] Updating vendor name to ERP name');
          extractedData.vendorName = erpCompany.name;
        }
      }
    }

    return {
      data: extractedData,
      confidence,
      rawResponse: JSON.stringify(extractedData, null, 2),
    };
  } catch (error) {
    console.error('[Extraction] Error:', error);
    return {
      data: null,
      confidence: 0,
      rawResponse: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Extraction with retry
 */
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
