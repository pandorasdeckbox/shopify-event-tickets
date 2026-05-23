const API_VERSION = '2025-01';
const INCLUDED_FINANCIAL_STATUSES = new Set([
  'AUTHORIZED',
  'PAID',
  'PARTIALLY_PAID',
  'PARTIALLY_REFUNDED',
  'PENDING',
]);

export async function searchProducts(session, searchText = '') {
  const query = `query ProductSearch($query: String!) {
    products(first: 25, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        status
        featuredImage {
          url
        }
        variants(first: 25) {
          nodes {
            id
            title
            sku
            barcode
            legacyResourceId
          }
        }
      }
    }
  }`;

  const searchQuery = buildProductSearchQuery(searchText);
  const payload = await runGraphql(session, query, { query: searchQuery });
  const nodes = payload.data?.products?.nodes || [];

  return nodes.map(product => ({
    id: product.id,
    legacyResourceId: gidToNumeric(product.id),
    title: product.title,
    status: product.status,
    image: product.featuredImage?.url || '',
    variants: (product.variants?.nodes || []).map(variant => ({
      id: variant.id,
      legacyResourceId: variant.legacyResourceId || gidToNumeric(variant.id),
      title: variant.title,
      sku: variant.sku || '',
      barcode: variant.barcode || '',
    })),
  }));
}

export async function buildTicketReport(session, { productId, variantId }) {
  const numericProductId = numericId(productId);
  const numericVariantId = numericId(variantId);

  if (!numericProductId) {
    throw new Error('Missing or invalid product ID');
  }
  if (!numericVariantId) {
    throw new Error('Missing or invalid variant ID');
  }

  const orderQuery = `product_id:${numericProductId}`;
  const rowsByOrderId = new Map();
  let cursor = null;
  let hasNextPage = true;
  let scannedOrders = 0;

  const query = `query TicketOrders($cursor: String, $orderQuery: String!) {
    orders(first: 50, after: $cursor, query: $orderQuery, sortKey: CREATED_AT, reverse: false) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          legacyResourceId
          name
          createdAt
          cancelledAt
          displayFinancialStatus
          email
          customer {
            firstName
            lastName
            email
          }
          shippingAddress {
            firstName
            lastName
            phone
          }
          billingAddress {
            firstName
            lastName
            phone
          }
          lineItems(first: 100) {
            edges {
              node {
                quantity
                title
                variantTitle
                variant {
                  legacyResourceId
                  product {
                    legacyResourceId
                    title
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  while (hasNextPage) {
    const payload = await runGraphql(session, query, {
      cursor,
      orderQuery,
    });

    const orders = payload.data?.orders;
    const edges = orders?.edges || [];

    for (const edge of edges) {
      const order = edge.node;
      scannedOrders += 1;

      if (order.cancelledAt) continue;
      if (!INCLUDED_FINANCIAL_STATUSES.has(order.displayFinancialStatus)) continue;

      const matchingLineItems = (order.lineItems?.edges || [])
        .map(itemEdge => itemEdge.node)
        .filter(lineItem => numericId(lineItem.variant?.legacyResourceId) === numericVariantId);

      if (!matchingLineItems.length) continue;

      const shipping = order.shippingAddress || {};
      const billing = order.billingAddress || {};
      const customer = order.customer || {};

      const firstName = shipping.firstName || billing.firstName || customer.firstName || '';
      const lastName = shipping.lastName || billing.lastName || customer.lastName || '';
      const email = order.email || customer.email || '';
      const phone = shipping.phone || billing.phone || '';
      const qty = matchingLineItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      const sampleLineItem = matchingLineItems[0];
      const orderId = String(order.legacyResourceId);

      rowsByOrderId.set(orderId, {
        order_id: orderId,
        order: order.name || `#${orderId}`,
        date: toDateOnly(order.createdAt),
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        qty,
        item_title: sampleLineItem.variant?.product?.title || sampleLineItem.title || '',
        variant_title: sampleLineItem.variantTitle || '',
        financial_status: order.displayFinancialStatus || '',
      });
    }

    hasNextPage = Boolean(orders?.pageInfo?.hasNextPage);
    cursor = orders?.pageInfo?.endCursor || null;
  }

  const rows = [...rowsByOrderId.values()].sort((left, right) => {
    const lastCompare = safeString(left.last_name).localeCompare(safeString(right.last_name));
    if (lastCompare !== 0) return lastCompare;

    const firstCompare = safeString(left.first_name).localeCompare(safeString(right.first_name));
    if (firstCompare !== 0) return firstCompare;

    return safeString(left.order).localeCompare(safeString(right.order));
  });

  const totalTickets = rows.reduce((sum, row) => sum + Number(row.qty || 0), 0);

  return {
    scannedOrders,
    totalOrders: rows.length,
    totalTickets,
    rows,
    eventTitle: rows[0]?.item_title || '',
    eventSubtitle: rows[0]?.variant_title || '',
  };
}

export function renderCheckinSheet(report, options = {}) {
  const title = (options.eventTitle || report.eventTitle || 'Event Check-In List').trim();
  const subtitle = (options.eventSubtitle || report.eventSubtitle || '').trim();
  const generatedAt = formatGeneratedTimestamp(new Date());
  const generatedDate = formatGeneratedDate(new Date());

  const rowsHtml = report.rows.map((row, index) => {
    const displayName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email || '(no name)';
    const boxes = Array.from({ length: Math.max(1, Number(row.qty || 0)) }, () => '<span class="box"></span>').join('');

    return `
      <tr>
        <td class="num">${index + 1}</td>
        <td class="check">${boxes}</td>
        <td class="name">${escapeHtml(displayName)}</td>
        <td class="qty">${escapeHtml(String(row.qty || 0))}</td>
        <td class="order">${escapeHtml(row.order || '')}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}${subtitle ? ` — ${escapeHtml(subtitle)}` : ''}</title>
<style>
  @page { margin: 0.75in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: #221c14;
    font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
    background:
      radial-gradient(circle at top left, rgba(190, 102, 40, 0.12), transparent 28%),
      linear-gradient(180deg, #fbf5eb 0%, #f7f0e2 100%);
    padding: 28px;
  }
  .sheet {
    max-width: 960px;
    margin: 0 auto;
    background: rgba(255, 252, 247, 0.94);
    border: 1px solid rgba(94, 63, 27, 0.14);
    border-radius: 20px;
    padding: 26px 28px 20px;
    box-shadow: 0 18px 40px rgba(84, 58, 31, 0.12);
  }
  h1 {
    margin: 0;
    font-size: 30px;
    line-height: 1.05;
    text-align: center;
    letter-spacing: -0.03em;
  }
  .subtitle {
    margin: 8px 0 0;
    text-align: center;
    font-size: 18px;
    color: #6e5a43;
  }
  .stats {
    margin: 10px 0 22px;
    text-align: center;
    font-size: 13px;
    color: #856d52;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .toolbar {
    display: flex;
    justify-content: center;
    gap: 10px;
    margin-bottom: 18px;
  }
  .toolbar button {
    border: 0;
    border-radius: 999px;
    background: #9d4f1d;
    color: white;
    padding: 10px 16px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .toolbar button.secondary {
    background: #e9dcc9;
    color: #5a4327;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  thead th {
    text-align: left;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8d7355;
    padding: 6px 8px 10px;
    border-bottom: 2px solid #43311f;
  }
  tbody tr {
    border-bottom: 1px solid #dfd3c2;
  }
  tbody tr:last-child {
    border-bottom: 2px solid #43311f;
  }
  td {
    padding: 10px 8px;
    vertical-align: middle;
  }
  td.num {
    width: 38px;
    text-align: center;
    color: #94785a;
    font-size: 12px;
  }
  td.check {
    width: 140px;
  }
  td.name {
    font-size: 18px;
    font-weight: 600;
  }
  td.qty {
    width: 70px;
    text-align: center;
    color: #6e5a43;
    font-weight: 700;
  }
  td.order {
    width: 120px;
    font-family: "SF Mono", Menlo, monospace;
    color: #8d7355;
    font-size: 11px;
  }
  .box {
    display: inline-block;
    width: 22px;
    height: 22px;
    border: 2px solid #43311f;
    border-radius: 4px;
    margin: 2px 4px 2px 0;
  }
  .footer {
    margin-top: 18px;
    text-align: center;
    color: #9a8468;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  @media print {
    body {
      background: white;
      padding: 0;
    }
    .sheet {
      box-shadow: none;
      border: 0;
      border-radius: 0;
      max-width: none;
      padding: 0;
    }
    .toolbar {
      display: none;
    }
  }
</style>
</head>
<body>
  <main class="sheet">
    <div class="toolbar no-print">
      <button onclick="window.print()">Print Sheet</button>
      <button class="secondary" onclick="window.close()">Close</button>
    </div>
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}
    <p class="stats">${report.totalTickets} tickets · ${report.totalOrders} orders · generated ${escapeHtml(generatedAt)}</p>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th></th>
          <th>Name</th>
          <th>Tickets</th>
          <th>Order</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || '<tr><td colspan="5">No ticket purchases found for this variant.</td></tr>'}
      </tbody>
    </table>
    <p class="footer">Generated ${escapeHtml(generatedDate)}</p>
  </main>
</body>
</html>`;
}

export function toCsv(rows) {
  const headers = ['order', 'date', 'first_name', 'last_name', 'email', 'phone', 'qty', 'item_title', 'variant_title', 'financial_status'];
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map(header => escapeCsv(row[header] || '')).join(','));
  }

  return lines.join('\n');
}

function buildProductSearchQuery(searchText) {
  const value = String(searchText || '').trim();
  if (!value) return 'status:active AND product_type:EVENT';
  return `status:active AND ${value}`;
}

async function runGraphql(session, query, variables) {
  const response = await fetch(`https://${session.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map(error => error.message).join('; '));
  }

  return payload;
}

function numericId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/(\d+)$/);
  return match ? match[1] : '';
}

function gidToNumeric(value) {
  return numericId(value);
}

function toDateOnly(value) {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 10);
}

function safeString(value) {
  return String(value || '').trim().toLowerCase();
}

function formatGeneratedTimestamp(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatGeneratedDate(date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeCsv(value) {
  const stringValue = String(value ?? '');
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll('"', '""')}"`;
}