// Orologio virtuale condiviso da server e "telefoni" del simulatore: il tempo scorre
// SCALE volte più veloce del reale a partire da V0, così un turno di ore dura pochi secondi.
// Si carica con:  node --import tests/chaos/fake-clock.mjs ...
const V0 = Number(process.env.CHAOS_V0);
const R0 = Number(process.env.CHAOS_R0);
const SCALE = Number(process.env.CHAOS_SCALE || 1);

if (V0 && R0) {
  const RealDate = Date;
  const virtualNow = () => V0 + (RealDate.now() - R0) * SCALE;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(virtualNow());
      else super(...args);
    }
    static now() {
      return virtualNow();
    }
  }
  globalThis.Date = FakeDate;
}
