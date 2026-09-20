"use client";

import { API_ORIGIN } from "@/lib/apiBase";
import { useState } from "react";

const API_URL = API_ORIGIN;

interface ValidationResult {
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export default function NewListingPage() {
  const [sku, setSku] = useState("");
  const [productType, setProductType] = useState("");
  const [attributesJson, setAttributesJson] = useState("{}");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function buildPayload() {
    return { productType, attributes: JSON.parse(attributesJson) };
  }

  async function handleValidate() {
    setError(null);
    setSubmitResult(null);
    try {
      const response = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(sku)}/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = (await response.json()) as ValidationResult;
      setValidation(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    }
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/api/listings/items/${encodeURIComponent(sku)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await response.json();
      setSubmitResult(response.ok ? `Enviado: ${data.submissionId}` : JSON.stringify(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-xl font-semibold">Nuevo listing</h1>

      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm text-slate-400">SKU</span>
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 p-2"
            value={sku}
            onChange={(event) => setSku(event.target.value)}
          />
        </label>

        <label className="block">
          <span className="text-sm text-slate-400">Product Type</span>
          <input
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 p-2"
            value={productType}
            onChange={(event) => setProductType(event.target.value)}
            placeholder="e.g. LUGGAGE"
          />
        </label>

        <label className="block">
          <span className="text-sm text-slate-400">Atributos (JSON)</span>
          <textarea
            className="mt-1 h-48 w-full rounded-md border border-slate-700 bg-slate-900 p-2 font-mono text-sm"
            value={attributesJson}
            onChange={(event) => setAttributesJson(event.target.value)}
          />
        </label>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleValidate}
            className="rounded-md border border-slate-700 px-4 py-2 text-sm"
          >
            Validar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm disabled:opacity-50"
          >
            {submitting ? "Enviando..." : "Publicar"}
          </button>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {validation && (
          <div className="rounded-md border border-slate-800 p-4 text-sm">
            <p className={validation.valid ? "text-emerald-400" : "text-amber-400"}>
              {validation.valid ? "Válido" : "Con errores"}
            </p>
            {validation.errors.map((issue, index) => (
              <p key={index} className="text-red-400">
                {issue.code}: {issue.message}
              </p>
            ))}
            {validation.warnings.map((issue, index) => (
              <p key={index} className="text-amber-300">
                {issue.code}: {issue.message}
              </p>
            ))}
          </div>
        )}

        {submitResult && <p className="text-sm text-emerald-400">{submitResult}</p>}
      </div>
    </main>
  );
}
