/**
 * Product catalog handler.
 *
 * Serves the canonical product manifest (cortex-owned) so any client —
 * desktop today, mobile / web / Slack tomorrow — reads the SAME validated
 * catalog instead of hardcoding its own product list. The response carries
 * CONTRACT fields only (slug, profilePolicy, defaultProfileId, status);
 * presentation (name, accent, glyph, copy) is layered on by each client,
 * keyed by slug.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON } from '../router.js'
import { listProducts } from '../../product/manifest.js'
import type { Product } from '../types.js'

// GET /api/v1/products
export async function productsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const products: readonly Product[] = listProducts()
  sendJSON(res, 200, products)
}
