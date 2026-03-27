// ERP API Types
export interface Company {
  id: string;
  name: string;
  taxId: string;
  address: string;
  country: string;
  createdAt: string;
}

// Extracted Invoice Data
export interface ExtractedData {
  invoiceNumber: string;
  vendorName: string;
  vendorTaxId: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  lineItems: LineItem[];
}

export interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

// Processed Invoice
export interface ProcessedInvoice {
  id: string;
  fileName: string;
  extractedData: ExtractedData;
  confidenceScore: number;
  processingNotes: string;
  processedAt: string;
  createdAt: string;
}

// Validation Status
export type ValidationStatus = 'matched' | 'flagged';

export interface ValidationResult {
  status: ValidationStatus;
  vendorMatched: boolean;
  taxIdMatched: boolean;
  matchedCompanyId?: string;
  notes: string[];
}

// API Response Types
export interface ProcessedInvoicesResponse {
  items: ProcessedInvoice[];
  total: number;
}

export interface SubmitInvoiceRequest {
  fileName: string;
  extractedData: ExtractedData;
  confidenceScore?: number;
  processingNotes?: string;
}

export interface DeleteResponse {
  deleted: number;
}

// Auth Types
export interface User {
  username: string;
  [key: string]: string | undefined;
}

// Dashboard Stats
export interface DashboardStats {
  totalInvoices: number;
  matchedVendors: number;
  flaggedIssues: number;
  totalsByCurrency: { currency: string; amount: number }[];
}

// Processing Status for UI
export type InvoiceStatus = 'pending' | 'processing' | 'processed' | 'error';

export interface InvoiceWithStatus {
  id: string;
  fileName: string;
  status: InvoiceStatus;
  extractedData?: ExtractedData;
  validation?: ValidationResult;
  confidenceScore?: number;
  processingNotes?: string;
  processedAt?: string;
  error?: string;
}
