/**
 * U10 / R6 — cost drivers in each service's NATIVE unit.
 *
 * Critically, the `unit` is rendered VERBATIM — we never force per-1,000 onto
 * capacity/storage/transfer services. The per-driver `note` is shown (this is
 * where the NAT-gateway / egress "required by private-subnet default" line
 * surfaces), and the on-demand-list-price disclaimer (from `assumptions`) is
 * shown beneath the table.
 */

import type { CostDriver } from "../lib/types.js";

/** The FULL cost-driver table. Rendered inside the collapsible CostEstimate's
 *  "show all" panel (and standalone in tests). */
export function CostTable({
  drivers,
  assumptions,
}: {
  drivers: CostDriver[];
  assumptions: string[];
}): JSX.Element {
  return (
    <div className="cost__full">
      <table className="cost__table">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Unit</th>
            <th scope="col">Estimate</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d, i) => (
            <tr key={`${d.service}-${i}`}>
              <td>{d.service}</td>
              <td className="cost__unit">{d.unit}</td>
              <td className="cost__range">{d.estimateRange}</td>
              <td className="cost__note">{d.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {assumptions.length > 0 && (
        <details className="cost__assumptions">
          <summary>Pricing assumptions &amp; disclaimer</summary>
          <ul>
            {assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
