import Link from "next/link";

// Top bar (app.py: "hero-section"). Only Home exists in this package: the other menus stay visible but greyed out.
const NAV_ITEMS = ["Home", "About", "Ash", "Data", "Seismic", "PMCC", "Infrasound", "Report"];
const ENABLED = new Set(["Home"]);

export default function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="site-logo">
          <div className="site-logo-title">L.A.V.A.</div>
          <div className="site-logo-sub">Live Acoustic &amp; Seismic Volcano Archive</div>
        </Link>
        <nav className="site-nav">
          {NAV_ITEMS.map((item) =>
            ENABLED.has(item) ? (
              <Link key={item} href={item === "Home" ? "/" : `/${item.toLowerCase()}`}>{item}</Link>
            ) : (
              <span key={item} title="Coming soon">{item}</span>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
