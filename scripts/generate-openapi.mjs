/**
 * Generate openapi.json from the SDK's real TypeScript types.
 *
 * Shapes are derived from packages/sdk/src/types.ts (in the beta-v2 monorepo)
 * via the TS compiler API — they cannot drift from the SDK. The route table
 * below is the only hand-listed part: method, path, tag, auth, params, and
 * which schema the response uses. The server's wrapping ({ workspace },
 * { keys }, { files }, …) follows packages/sdk/docs/API.md, which documents
 * the raw HTTP contract.
 *
 * Run: node scripts/generate-openapi.mjs [--sdk-types=<path to types.ts>]
 * (or set SYVON_SDK_TYPES). Defaults to the sibling beta-v2 checkout.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// This repo is standalone; the SDK types live in the monorepo. Locate them
// via: CLI arg → SYVON_SDK_TYPES → sibling checkout guesses.
const arg = process.argv.find((a) => a.startsWith('--sdk-types='));
const candidates = [
  arg?.split('=')[1],
  process.env.SYVON_SDK_TYPES,
  join(here, '..', '..', 'beta-v2', 'packages', 'sdk', 'src', 'types.ts'),
  'D:/syvon/Dev/beta-v2/packages/sdk/src/types.ts',
].filter(Boolean);

const TYPES_PATH = candidates.find((p) => existsSync(p));
if (!TYPES_PATH) {
  console.error(
    'Cannot find packages/sdk/src/types.ts. Pass --sdk-types=<path> or set SYVON_SDK_TYPES.',
  );
  process.exit(1);
}
const monorepo = resolve(TYPES_PATH, '..', '..', '..', '..'); // …/beta-v2

// Resolve typescript from the monorepo (this repo has no deps of its own).
const require = createRequire(import.meta.url);
function loadTs() {
  const tries = [
    join(monorepo, 'node_modules', 'typescript'),
    join(monorepo, 'apps', 'portal', 'node_modules', 'typescript'),
    join(monorepo, 'packages', 'sdk', 'node_modules', 'typescript'),
    'typescript',
  ];
  for (const c of tries) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('typescript not found — run with the monorepo present');
}
const ts = loadTs();

// ── TS types → JSON Schema ──────────────────────────────────────────────────

const source = readFileSync(TYPES_PATH, 'utf8');
const sf = ts.createSourceFile(TYPES_PATH, source, ts.ScriptTarget.Latest, true);

/** Every top-level interface + union alias, by name. */
const decls = new Map();
for (const stmt of sf.statements) {
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
    decls.set(stmt.name.text, stmt);
  }
}

/**
 * Extract a member's JSDoc description from the raw text (the AST does not
 * attach jsDoc to an unbound source file), e.g. `/** The raw key. *\/`.
 */
function doc(node) {
  const ranges = ts.getLeadingCommentRanges(source, node.pos) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last || source.charCodeAt(last.pos) !== 0x2f /* / */) return undefined;
  const text = source.slice(last.pos, last.end);
  if (!text.startsWith('/**')) return undefined;
  return text
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    || undefined;
}

function typeRefSchema(name) {
  const decl = decls.get(name);
  if (!decl) return {};
  if (ts.isInterfaceDeclaration(decl)) return interfaceSchema(decl);
  if (ts.isTypeAliasDeclaration(decl)) return typeSchema(decl.type);
  return {};
}

function literalSchema(node) {
  if (node.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
  if (ts.isStringLiteral(node)) return { type: 'string', enum: [node.text] };
  if (ts.isNumericLiteral(node)) return { type: 'number', enum: [Number(node.text)] };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { type: 'boolean', enum: [true] };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { type: 'boolean', enum: [false] };
  return {};
}

const isNullType = (t) =>
  t.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword);

function unionSchema(node) {
  const parts = node.types.filter((t) => !isNullType(t));
  const nullable = node.types.length !== parts.length;
  const schemas = parts.map(typeSchema);
  let merged;
  if (schemas.every((s) => s.type === 'string' && !s.items)) {
    // String-literal union (possibly widened with `| string`): collapse to one
    // enum-bearing string schema; a plain `string` member widens it away.
    const widened = parts.some((p) => p.kind === ts.SyntaxKind.StringKeyword);
    merged = widened ? { type: 'string' } : { type: 'string', enum: schemas.flatMap((s) => s.enum) };
  } else if (schemas.length === 1) {
    merged = schemas[0];
  } else {
    merged = { anyOf: schemas };
  }
  return nullable ? { anyOf: [merged, { type: 'null' }] } : merged;
}

function typeSchema(node) {
  if (ts.isUnionTypeNode(node)) return unionSchema(node);
  if (ts.isLiteralTypeNode(node)) return literalSchema(node.literal);
  if (ts.isArrayTypeNode(node)) return { type: 'array', items: typeSchema(node.elementType) };
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(sf);
    const builtin = {
      string: { type: 'string' },
      number: { type: 'number' },
      boolean: { type: 'boolean' },
      unknown: {},
      Date: { type: 'string', format: 'date-time' },
      Record: {
        type: 'object',
        additionalProperties: node.typeArguments?.[1] ? typeSchema(node.typeArguments[1]) : true,
      },
    };
    if (builtin[name]) return builtin[name];
    return { $ref: `#/components/schemas/${name}` };
  }
  if (ts.isTypeLiteralNode(node)) return literalTypeSchema(node);
  if (node.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { type: 'null' };
  if (ts.isTupleTypeNode?.(node)) return { type: 'array', items: {} };
  return {};
}

function literalTypeSchema(node) {
  const props = {};
  const required = [];
  for (const m of node.members) {
    if (ts.isPropertySignature(m) && m.name && m.type) {
      const name = m.name.getText(sf);
      props[name] = { description: doc(m) ?? '', ...typeSchema(m.type) };
      if (!m.questionToken) required.push(name);
    }
  }
  const schema = { type: 'object', properties: props };
  if (required.length) schema.required = required;
  return schema;
}

function interfaceSchema(decl) {
  const props = {};
  const required = [];
  for (const m of decl.members) {
    if (ts.isPropertySignature(m) && m.name && m.type) {
      const name = m.name.getText(sf);
      props[name] = { description: doc(m) ?? '', ...typeSchema(m.type) };
      if (!m.questionToken) required.push(name);
    } else if (ts.isIndexSignatureDeclaration(m)) {
      // [k: string]: unknown → open object
      props['x-index'] = undefined;
    }
  }
  delete props['x-index'];
  const schema = {
    type: 'object',
    description: doc(decl) ?? '',
    properties: props,
  };
  if (required.length) schema.required = required;
  if (ts.isInterfaceDeclaration(decl) && decl.heritageClauses?.length) {
    // `extends Foo` → allOf with the base ref.
    const bases = decl.heritageClauses.flatMap((c) =>
      c.types.map((t) => ({ $ref: `#/components/schemas/${t.expression.getText(sf)}` })),
    );
    return { allOf: [...bases, schema] };
  }
  // Index-signature bodies are open.
  if (decl.members.some(ts.isIndexSignatureDeclaration)) schema.additionalProperties = true;
  return schema;
}

// Emit every exported interface/alias as a component schema.
const schemas = {};
for (const [name, decl] of decls) {
  schemas[name] = ts.isInterfaceDeclaration(decl) ? interfaceSchema(decl) : typeSchema(decl.type);
}

// ── Route table (the only hand-maintained part) ─────────────────────────────

const PORTAL = 'https://syvon.ai';
const BRAIN = 'https://brain.syvon.ai';
const JWT = [{ bearerAuth: [] }];
const WSKEY = [{ workspaceKeyAuth: [] }];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (name) => ({ type: 'array', items: ref(name) });
const wrapped = (name, key) => ({
  type: 'object',
  properties: { [key]: ref(name) },
  required: [key],
});
const openObject = { type: 'object', additionalProperties: true };

const param = (name, where, description, schema = { type: 'string' }) => ({
  name, in: where, required: true, description, schema,
});
const qparam = (name, description, schema = { type: 'string' }) => ({
  name, in: 'query', required: false, description, schema,
});

const routes = [
  // ── Auth ──────────────────────────────────────────────────────────────────
  {
    tag: 'Auth', method: 'post', path: '/api/auth/api-token', servers: [PORTAL],
    operationId: 'mintPortalToken',
    summary: 'Mint a portal API JWT',
    description: 'From a signed-in session (magic link / Google / Apple cookie). The JWT is user-scoped and lives ~1 hour; refresh via POST /api/auth/refresh.',
    security: [{ sessionCookie: [] }],
    responses: { 200: { description: 'The token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } } } },
  },

  // ── Portal ────────────────────────────────────────────────────────────────
  {
    tag: 'Portal', method: 'get', path: '/api/user/account', servers: [PORTAL],
    operationId: 'getAccount',
    summary: "The authenticated user's account",
    security: JWT,
    responses: { 200: json('The account', ref('Account')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces', servers: [PORTAL],
    operationId: 'listWorkspaces',
    summary: "List the caller's workspaces (membership-scoped)",
    security: JWT,
    responses: { 200: json('Workspace list', arrayOf('WorkspaceListItem')) },
  },
  {
    tag: 'Portal', method: 'post', path: '/api/workspaces', servers: [PORTAL],
    operationId: 'createWorkspace',
    summary: 'Create and activate an empty workspace',
    description: 'Plan-gated: returns 402 over the plan limit.',
    security: JWT,
    body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    responses: { 200: json('The new workspace (includes its R2 prefix)', openObject), 402: err('Over the plan workspace limit') },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}', servers: [PORTAL],
    operationId: 'getWorkspace',
    summary: 'Fetch one workspace (member-only)',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('The workspace', wrapped('Workspace', 'workspace')) },
  },
  {
    tag: 'Portal', method: 'patch', path: '/api/workspaces/{id}', servers: [PORTAL],
    operationId: 'updateWorkspace',
    summary: 'Update workspace name/slug/settings (owner or admin only)',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    body: null, // ref below — set after ref() helpers exist
    bodyRef: 'UpdateWorkspaceInput',
    responses: { 200: json('The updated workspace', wrapped('Workspace', 'workspace')) },
  },
  {
    tag: 'Portal', method: 'delete', path: '/api/workspaces/{id}', servers: [PORTAL],
    operationId: 'deleteWorkspace',
    summary: 'PERMANENTLY delete a workspace and all of its R2 content',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('Deletion result', ref('DeleteResult')) },
  },
  {
    tag: 'Portal', method: 'post', path: '/api/workspaces/{id}/activate', servers: [PORTAL],
    operationId: 'activateWorkspace',
    summary: "Set a workspace as the caller's active workspace",
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: { description: 'Activated' } },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}/members', servers: [PORTAL],
    operationId: 'listMembers',
    summary: 'List workspace members (member-only)',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('Members', arrayOf('WorkspaceMember')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}/brands', servers: [PORTAL],
    operationId: 'listBrands',
    summary: 'DB-authoritative brand list',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('Brands', arrayOf('CloudBrand')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}/keys', servers: [PORTAL],
    operationId: 'listApiKeys',
    summary: 'API key metadata for the workspace (raw keys are never returned)',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('Key metadata', wrapped2('ApiKeyMetadata', 'keys')) },
  },
  {
    tag: 'Portal', method: 'post', path: '/api/workspaces/{id}/keys', servers: [PORTAL],
    operationId: 'mintApiKey',
    summary: 'Mint a workspace API key (owner/admin + multi-workspace plan)',
    description: 'Returns the raw sk_ws_… key ONCE. 402 with code API_KEYS_NOT_AVAILABLE on a single-workspace plan.',
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    body: { type: 'object', properties: { name: { type: 'string' }, rateLimit: { type: 'number' } }, required: ['name'] },
    responses: {
      200: json('The minted key (raw key shown once)', wrapped2('MintedApiKey', 'key')),
      402: err('API keys not available on this plan'),
    },
  },
  {
    tag: 'Portal', method: 'delete', path: '/api/workspaces/{id}/keys/{keyId}', servers: [PORTAL],
    operationId: 'revokeApiKey',
    summary: 'Revoke an API key',
    security: JWT,
    params: [param('id', 'path', 'Workspace id'), param('keyId', 'path', 'Key id')],
    responses: { 200: json('The revoked key metadata', openObject) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/credits/balance', servers: [PORTAL],
    operationId: 'getCreditBalance',
    summary: "The caller's credit balance (1 credit = $0.0001)",
    security: JWT,
    responses: { 200: json('Balance', ref('CreditBalance')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/credits/history', servers: [PORTAL],
    operationId: 'getCreditHistory',
    summary: 'Paginated credit ledger entries',
    security: JWT,
    params: [
      qparam('limit', 'Page size', { type: 'number' }),
      qparam('offset', 'Page offset', { type: 'number' }),
      qparam('type', 'Filter by refType (render, voice, llm, topup, …)'),
    ],
    responses: { 200: json('History', ref('CreditHistory')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}/flows', servers: [PORTAL],
    operationId: 'listFlows',
    summary: "List the workspace's workflows / flows",
    security: JWT,
    params: [param('id', 'path', 'Workspace id')],
    responses: { 200: json('Flows', arrayOf('WorkflowSummary')) },
  },
  {
    tag: 'Portal', method: 'get', path: '/api/workspaces/{id}/files', servers: [PORTAL],
    operationId: 'listFiles',
    summary: "The workspace's file index (workspace-relative R2 keys)",
    security: JWT,
    params: [param('id', 'path', 'Workspace id'), qparam('prefix', 'Filter by key prefix')],
    responses: { 200: json('File index', wrapped3()) },
  },

  // ── Brain ─────────────────────────────────────────────────────────────────
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/_whoami', servers: [BRAIN],
    operationId: 'whoami',
    summary: 'Verify the workspace key resolves',
    security: WSKEY,
    responses: { 200: json('Which workspace and key this is', ref('WhoAmI')) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}', servers: [BRAIN],
    operationId: 'getAgent',
    summary: 'Published agent metadata',
    description: 'agentId is a Project id in the key\'s workspace. Slugs are not accepted. 404 for an unknown id or an agent outside the workspace.',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('Agent metadata', ref('AgentMetadata')), 404: err('Unknown agent') },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/wrap', servers: [BRAIN],
    operationId: 'getWrapConfig',
    summary: 'The published presentation config (layout, greeting, theme)',
    description: 'Unpublished agents return neutral defaults. The parser never throws.',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('Wrap config', openObject) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/site', servers: [BRAIN],
    operationId: 'getSiteConfig',
    summary: 'The published brand-site config (sitemap, nav, sections)',
    description: 'An empty pages array means "no site published".',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('Site config', openObject) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/files', servers: [BRAIN],
    operationId: 'getAgentFiles',
    summary: 'The frozen workspace file index for the release',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('File entries', ref('AgentFilesResponse')) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/items', servers: [BRAIN],
    operationId: 'getItems',
    summary: "The agent's active items",
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('Items', arrayOf('AgentItem')) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/suggestions', servers: [BRAIN],
    operationId: 'getSuggestions',
    summary: 'Workflow starter suggestions',
    description: 'Shape is workflow-defined.',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    responses: { 200: json('Suggestions', openObject) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/agent/{agentId}/feed', servers: [BRAIN],
    operationId: 'getFeed',
    summary: 'Published feed posts (newest first, up to 120)',
    security: WSKEY,
    params: [
      param('agentId', 'path', 'Project (agent) id'),
      qparam('channel', 'Filter by channel (instagram, site, …)'),
      qparam('category', 'Filter by category'),
    ],
    responses: { 200: json('Published posts', arrayOf('FeedPost')) },
  },
  {
    tag: 'Brain', method: 'get', path: '/v1/r2/{path}', servers: [BRAIN],
    operationId: 'streamR2File',
    summary: 'Stream a raw workspace R2 object',
    description: 'Workspace-relative key. Only allowlisted prefixes (brands/, projects/, workflows/, …) are reachable; others 403. Pipe the body; do not buffer large objects.',
    security: WSKEY,
    params: [param('path', 'path', 'Workspace-relative R2 key, e.g. brands/acme/design-tokens.json')],
    responses: {
      200: { description: 'The raw object bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      403: err('Prefix not allowlisted'),
    },
  },
  {
    tag: 'Brain', method: 'post', path: '/v1/agent/{agentId}/chat', servers: [BRAIN],
    operationId: 'chat',
    summary: 'Public agent chat (NDJSON stream)',
    description: 'One JSON event per line; assemble the reply from event.text. The agent owner is billed for the turn. Pass a salted client hash for per-visitor rate limiting (never a raw IP). 429 when rate limited.',
    security: WSKEY,
    params: [param('agentId', 'path', 'Project (agent) id')],
    bodyRef: 'ChatRequest',
    responses: {
      200: {
        description: 'NDJSON stream of ChatStreamEvent, one per line',
        content: { 'application/x-ndjson': { schema: arrayOf('ChatStreamEvent') } },
      },
      429: err('Rate limited — back off'),
    },
  },
];

// Small helpers used above that need late binding.
function wrapped2(name, key) {
  const s = wrapped(name, key);
  s.properties[key] = Array.isArray(name) ? s.properties[key] : (
    key === 'keys' ? { type: 'array', items: ref(name) } : s.properties[key]
  );
  return s;
}
function wrapped3() {
  return {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            size: { type: 'number' },
            mimeType: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['files'],
  };
}
function json(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}
function err(description) {
  return {
    description,
    content: { 'application/json': { schema: {
      type: 'object',
      properties: { error: { type: 'string' }, code: { type: 'string' } },
    } } },
  };
}

// ── Assemble the spec ───────────────────────────────────────────────────────

const paths = {};
for (const r of routes) {
  const item = (paths[r.path] ??= {});
  const op = {
    tags: [r.tag],
    summary: r.summary,
    description: r.description ?? '',
    operationId: r.operationId,
    parameters: r.params,
    responses: r.responses,
  };
  if (r.security) op.security = r.security;
  if (r.servers) op.servers = r.servers;
  if (r.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: r.body } },
    };
  } else if (r.bodyRef) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: ref(r.bodyRef) } },
    };
  }
  item[r.method] = op;
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Syvon API',
    version: '1.0.0',
    description:
      'Two client-facing surfaces: the Portal management plane (syvon.ai/api/*, portal JWT) and the Brain read plane (brain.syvon.ai/v1/*, workspace key sk_ws_…). Schemas are generated from the @syvon/sdk TypeScript types — the shipped .d.ts files are the authoritative contract.',
  },
  servers: [{ url: PORTAL, description: 'Portal (management plane)' }, { url: BRAIN, description: 'Brain (read plane)' }],
  tags: [
    { name: 'Auth', description: 'Minting the portal JWT' },
    { name: 'Portal', description: 'Management plane — user-scoped (portal JWT)' },
    { name: 'Brain', description: 'Published-agent read plane — workspace-scoped (sk_ws_…)' },
  ],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Portal API JWT (user-scoped, ~1h)' },
      workspaceKeyAuth: { type: 'http', scheme: 'bearer', description: 'Workspace API key (sk_ws_…)' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'next-auth.session-token', description: 'A signed-in portal session' },
    },
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, s]) => {
        const copy = { ...s };
        delete copy.$ref; // top-level refs to self are meaningless
        return [name, copy];
      }),
    ),
  },
  'x-generated-from': 'packages/sdk/src/types.ts',
};

const outPath = join(here, '..', 'openapi.json');
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${outPath} — ${Object.keys(paths).length} paths, ${Object.keys(schemas).length} schemas`);
