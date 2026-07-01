/**
 * `/gallery` — the full community gallery of operator-approved designs. The browsing
 * logic (fetch, filter by type/capability, sort, vote) lives in the shared
 * {@link GalleryBrowser}, which also renders inline on the landing page; this route is
 * just the page chrome around it.
 */
import { Link } from "react-router-dom";
import { GalleryBrowser } from "./GalleryBrowser.js";

export function GalleryView(): JSX.Element {
  return (
    <main className="app app--submitted">
      <header className="app__header">
        <span className="app__brand">Drafture</span>
        <div className="app__header-actions">
          <Link className="result__back" to="/">
            ← Back to start
          </Link>
        </div>
        <h1 className="app__goal">
          <span className="app__goal-text">Community gallery</span>
        </h1>
      </header>

      <section className="gallery" aria-label="Community designs">
        <p className="gallery__sub">
          Operator-approved designs from the community — open any one instantly, free.
        </p>
        <GalleryBrowser />
      </section>
    </main>
  );
}
