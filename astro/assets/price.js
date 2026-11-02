// Brodoit pandit prices (v34): one rule for the page and the server, so a booking's price is never taken from the browser.
// price = the puja's metro rate for the package × the city's tier, rounded to ₹100 (₹50 under ₹1,000).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AstroPrice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PKGS = ['basic', 'standard', 'premium'];
  function price(puja, pkg, city, tiers) {
    const i = typeof pkg === 'number' ? pkg : PKGS.indexOf(pkg);
    if (!puja || !city || i < 0 || !puja.p || puja.p[i] == null) return null;
    const x = puja.p[i] * ((tiers && tiers[city.tier]) || 1), step = x < 1000 ? 50 : 100;
    return Math.round(x / step) * step;
  }
  const available = (puja, cityId) => !!puja && (!puja.only || puja.only.includes(cityId));
  const famous = (puja, cityId) => !!puja && !!puja.famous && puja.famous.includes(cityId);
  const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  return { PKGS, price, available, famous, rupees };
});
