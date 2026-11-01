let bc; Object.defineProperty(global, '_broCore', { configurable: true, get() { return bc; }, set(v) { if (v) { v.voiceKey = () => 'energetic-srv00001'; v.voiceReady = () => false; } bc = v; } });
