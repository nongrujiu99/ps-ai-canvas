# Local Image Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one Windows loopback service that validates image jobs, stores the Bailian credential, runs Alibaba image tasks, and returns local preview images to either Photoshop host.

**Architecture:** A Node.js service binds only to `127.0.0.1`; Photoshop hosts exchange versioned JSON with encoded images or raw 8-bit pixels. The provider adapter knows Alibaba's submit/poll/download protocol; the HTTP layer never logs API keys or image contents. A Windows Credential Manager helper stores the key under the current user.

**Tech Stack:** Node.js 22+ built-in HTTP/fetch/test modules, `sharp` for PNG inspection and cropping, PowerShell/WinCred helper for the Windows key store.

**Spec:** `docs/superpowers/specs/2026-11-10-ps-ai-fill-design.md`

## Global Constraints

- First release: Windows; API host is the Beijing Bailian workspace endpoint.
- Edit model: `wanx2.1-imageedit`; generation model: `wan2.7-image`.
- Inputs: RGB 8-bit, opaque original region, optional rectangular transparent expansion border.
- Edit input: sides 512–4096 pixels, at most 10 MB; expansion scales 1.0–2.0.
- Default candidate count: 1; no more than 4.
- Key never appears in source, PSD, logs, error text, or response JSON.
- No silent downscaling, no implicit extra paid job, and no modification of PSD before acceptance.
- This workspace currently has no Git repository; initialize a local repository before the first commit step, without adding a remote.

## Review Focus

- A PNG with an irregular transparent hole must not be misclassified as expansion (Task 1 test).
- A selection covering both opaque pixels and a transparent edge must return an ambiguity error (Task 1 test).
- A 4097-pixel image or file over 10 MB must be rejected before any provider request (Task 1 test).
- A failed or timed-out task must not expose the key or leave a successful-looking result (Task 2 test).
- A browser page with a foreign Origin or without the plugin request header must not create a billable job (Task 3 test).

---

### Task 1: Shared Request Contract and Image Inspection

**Files:**
- Create: `service/package.json`, `service/src/contract.js`, `service/src/image-inspection.js`
- Test: `service/test/contract.test.js`, `service/test/image-inspection.test.js`

**Interfaces:**
- Produces: `validateJob(input) -> JobRequest`, where `JobRequest.operation` is `editMasked | editWhole | expand | generate`. `image` accepts `{ kind: "encoded", dataUrl }` or `{ kind: "rgba", width, height, dataBase64 }`; `mask` accepts encoded PNG or `{ kind: "gray8", width, height, dataBase64 }`.
- Produces: `decodeCapture(image, mask?) -> { pngBytes, maskBytes? }`; converts raw RGBA/Gray8 to PNG when needed.
- Produces: `inspectImage(pngBytes, maskBytes?) -> { width, height, opaqueBounds, selectionKind }`; `selectionKind` is `inside | transparentBorder | ambiguous | none`.
- Produces: `prepareExpansion(pngBytes, maskBytes?) -> { originalPng, topScale, rightScale, bottomScale, leftScale }` for a rectangular transparent border only.
- Consumed by: Tasks 2–3 and both Photoshop host plans.

- [ ] **Step 1: Write contract tests** for the four operations, optional prompt defaults, count 1–4, strength only for whole edit, and exact size/scale limits.
- [ ] **Step 2: Run** `node --test service/test/contract.test.js`; confirm missing implementation fails.
- [ ] **Step 3: Implement** `validateJob` with stable error codes and no automatic paid retries.
- [ ] **Step 4: Write image tests** with small generated fixtures: encoded and raw input, opaque interior, four rectangular transparent borders, irregular hole, mixed selection, 4097-pixel side, and over-10-MB input.
- [ ] **Step 5: Run** `node --test service/test/image-inspection.test.js`; confirm missing implementation fails.
- [ ] **Step 6: Implement** `decodeCapture`, `inspectImage`, and `prepareExpansion`; preserve the original pixel dimensions and reject ambiguous geometry.
- [ ] **Step 7: Run** `node --test service/test/contract.test.js service/test/image-inspection.test.js`; expect all pass.
- [ ] **Step 8: Commit** this tested contract and inspection layer.

### Task 2: Alibaba Provider and Async Job Lifecycle

**Files:**
- Create: `service/src/providers/aliyun.js`, `service/src/jobs.js`
- Test: `service/test/aliyun.test.js`, `service/test/jobs.test.js`

**Interfaces:**
- Consumes: `JobRequest` from Task 1.
- Produces: `createAliyunProvider({ fetchImpl, endpoint, apiKey }) -> { submit(request), poll(taskId), download(url) }`.
- Produces: `createJobManager({ provider, now }) -> { start(request), get(jobId), cancelWait(jobId) }`; results are copied to local bytes before remote URLs expire.

- [ ] **Step 1: Write mocked HTTP tests** asserting `description_edit_with_mask`, `description_edit`, `expand`, and `wan2.7-image` request mapping; check input and output JSON against current official API examples.
- [ ] **Step 2: Run** `node --test service/test/aliyun.test.js`; confirm failure.
- [ ] **Step 3: Implement** submit, poll, and result download; send the key only in the Authorization header.
- [ ] **Step 4: Write lifecycle tests** for pending/running/succeeded/failed, timeout, cancel-wait, expired result URL, and key redaction.
- [ ] **Step 5: Run** `node --test service/test/jobs.test.js`; confirm failure.
- [ ] **Step 6: Implement** bounded polling and local result retention; cancellation stops waiting but never claims to reverse a submitted task.
- [ ] **Step 7: Run** `node --test service/test/aliyun.test.js service/test/jobs.test.js`; expect all pass.
- [ ] **Step 8: Commit** the provider and lifecycle layer.

### Task 3: Local HTTP Service and Windows Credential Storage

**Files:**
- Create: `service/src/server.js`, `service/src/credential-store.js`, `service/scripts/wincred.ps1`, `service/test/server.test.js`, `service/test/credential-store.test.js`
- Modify: `service/package.json`

**Interfaces:**
- Consumes: `validateJob`, `inspectImage`, `prepareExpansion`, `createJobManager`.
- Produces: `createServer({ jobManager, credentialStore, allowedOrigins }) -> http.Server`.
- Routes: `POST /v1/inspect` (non-billable selection classification), `POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/results/:id/:index` (PNG), `GET /v1/results/:id/:index/raw` (RGBA bytes with width/height headers), `DELETE /v1/jobs/:id`, `GET /v1/settings/status`, `PUT /v1/settings/key`.
- Every billable or credential route requires the plugin's `X-PSAI-Client` header, an allowed Origin when Origin is present, and `application/json` for JSON bodies. The service binds only to loopback; these browser checks do not pretend to authenticate other processes running as the same Windows user.

- [ ] **Step 1: Write server tests** for non-billable inspection, a successful job flow, invalid JSON, missing plugin header, unsupported origin/content type, oversized body, missing key, and sanitized errors.
- [ ] **Step 2: Run** `node --test service/test/server.test.js`; confirm failure.
- [ ] **Step 3: Implement** the loopback-only HTTP service and reject requests before job submission when validation fails.
- [ ] **Step 4: Write credential-store tests** with a fake PowerShell runner, then a Windows-only manual round-trip check for CredWrite/CredRead/CredDelete under the current account.
- [ ] **Step 5: Implement** the WinCred bridge with the key passed over stdin, never in command arguments or logs.
- [ ] **Step 6: Run** `node --test service/test/*.test.js`; expect all automated tests pass.
- [ ] **Step 7: Commit** the service, including a `service/README.md` with configuration and API examples that use dummy values.

## Service Handoff

The CEP and UXP plans consume this exact `/v1` HTTP contract. Run one mocked end-to-end job through the service before starting either Photoshop host. A real Alibaba smoke test requires the user's API key; never check it into the repository or print it in a test report.
