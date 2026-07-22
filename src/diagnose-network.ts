import { config } from "./config";

/**
 * Run with: npm run diagnose:network
 *
 * On networks with transparent TLS interception (Zscaler, corporate SSL
 * inspection, etc.), curl and browsers work fine because they trust the OS
 * certificate store — but Node does NOT read that store by default and will
 * fail every HTTPS request with "unable to get local issuer certificate"
 * unless NODE_EXTRA_CA_CERTS is set to point at it. This script checks that
 * first, since it explains a total, uniform failure across every source far
 * more often than proxy/firewall configuration does.
 */

async function checkTls(): Promise<boolean> {
  const extraCa = process.env.NODE_EXTRA_CA_CERTS;
  console.log(
    extraCa
      ? `NODE_EXTRA_CA_CERTS is set: ${extraCa}`
      : "NODE_EXTRA_CA_CERTS is NOT set — if your network does TLS interception " +
          "(e.g. Zscaler, corporate SSL inspection), every HTTPS request will fail " +
          "until this points at your OS's CA bundle, commonly " +
          "/etc/ssl/certs/ca-certificates.crt on Debian/Ubuntu-based systems."
  );

  try {
    const res = await fetch("https://example.com");
    console.log(`TLS check OK — https://example.com returned ${res.status}`);
    return true;
  } catch (err) {
    console.log(`TLS check FAILED: ${(err as Error).message}`);
    if (!extraCa) {
      console.log(
        "Fix: export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt " +
          "(add to ~/.bashrc so it's set before Node starts, not just in .env)."
      );
    }
    return false;
  }
}

async function checkSource(name: string, url: string) {
  if (!url) {
    console.log(`[${name}] SKIPPED — no URL configured in .env`);
    return;
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
    });
    console.log(`[${name}] HTTP ${res.status} ${res.statusText} — ${url}`);
  } catch (err) {
    console.log(`[${name}] FAILED (${(err as Error).message}) — ${url}`);
  }
}

(async () => {
  console.log("--- TLS / CA certificate check ---");
  const tlsOk = await checkTls();

  console.log("\n--- Per-source connectivity ---");
  await checkSource("OFAC SDN", config.sources.ofacSdnUrl);
  await checkSource("OFAC Consolidated", config.sources.ofacConsolidatedUrl);
  await checkSource("UN Consolidated", config.sources.unConsolidatedUrl);
  await checkSource("EU Consolidated", config.sources.euConsolidatedUrl);

  if (!tlsOk) {
    console.log(
      "\nFix the TLS/CA issue above first — until that's resolved, every HTTPS " +
        "source will fail regardless of anything else."
    );
  }
})();
