

const DEFAULT_PRESETS = [
    {
        id: 'default-upscale',
        name: 'Upscale & Enhance',
        content: " Upscale and enhance: Strictly preserve original color palette and tonal balance. Improve resolution by restoring and adding realistic textural details (skin, fabric, leather, wood, metal, glass, stone) without altering global hue or saturation. Textures / materials: Increase microstructure and micro-contrast (fibers, pores, veins, grain) for each material, plausibly revealing fine details (seams, cracks, fibrils) without creating artifacts or new objects. Lights / reflections: Reinforce highlight and specular precision — clean and refine reflections (specularity, anisotropy) for realism, avoiding highlight clipping. Preserve deep shadows for depth. Sharpness: Apply localized sharpening (edges and textures) — no global oversharpening or halos around smooth contours. Enhance micro-sharpness of details without accentuating noise. Faces and skin: Preserve skin tones and natural softness; improve skin textures without adding artificial wrinkles or changing identity. Noise & artifacts: Light noise reduction, preserving fine details; remove AI artifacts and halos. Final result: High-fidelity upscaled image, unchanged colors, realistic textures and reflections, controlled sharpness, zero object hallucinations.",
        active: false
    }
];

class PresetManager {
    constructor() {
        this.presets = [];
        this.storageKey = 'googleAiPresets';
    }

    async load() {
        // Use standard Web localStorage for settings
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                this.presets = JSON.parse(stored);
            } else {
                this.presets = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
                this.save(); // Initialize default in storage
            }
        } catch (e) {
            console.warn("Failed to load presets:", e);
            this.presets = JSON.parse(JSON.stringify(DEFAULT_PRESETS));
        }
        return this.presets;
    }

    async save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.presets));
        } catch (e) {
            console.error("Failed to save presets:", e);
        }
    }

    getAll() {
        return this.presets;
    }

    add(name, content) {
        const newPreset = {
            id: 'preset-' + Date.now().toString(36) + Math.random().toString(36).substr(2),
            name: name || 'Untitled Preset',
            content: content || '',
            active: false
        };
        this.presets.push(newPreset);
        this.save();
        return newPreset;
    }

    update(id, updates) {
        const index = this.presets.findIndex(p => p.id === id);
        if (index !== -1) {
            this.presets[index] = { ...this.presets[index], ...updates };
            this.save();
            return true;
        }
        return false;
    }

    delete(id) {
        const index = this.presets.findIndex(p => p.id === id);
        if (index !== -1) {
            this.presets.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }

    toggleActive(id, isActive) {
        // Find preset and set active state. 
        // Note: We might want allow multiple active? User said "toggle them". yes.
        return this.update(id, { active: isActive });
    }
}

module.exports = new PresetManager();
