import { useState } from 'react';
import type { PoseSettings } from '../../types/pose';

interface SettingsPanelProps {
    settings: PoseSettings;
    onChange: (settings: PoseSettings) => void;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
    const [isOpen, setIsOpen] = useState(false);

    const handleChange = (key: keyof PoseSettings, value: string | number) => {
        onChange({
            ...settings,
            [key]: value,
        });
    };

    return (
        <div className="settings-panel">
            <button
                className="settings-toggle"
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className="toggle-icon">{isOpen ? '▼' : '▶'}</span>
                <span>表示設定</span>
            </button>

            {isOpen && (
                <div className="settings-content">
                    <div className="setting-item">
                        <label htmlFor="pointColor">ポイント色</label>
                        <input
                            type="color"
                            id="pointColor"
                            value={settings.pointColor}
                            onChange={(e) => handleChange('pointColor', e.target.value)}
                        />
                    </div>

                    <div className="setting-item">
                        <label htmlFor="lineColor">線の色</label>
                        <input
                            type="color"
                            id="lineColor"
                            value={settings.lineColor}
                            onChange={(e) => handleChange('lineColor', e.target.value)}
                        />
                    </div>

                    <div className="setting-item">
                        <label htmlFor="pointSize">
                            ポイントサイズ: {settings.pointSize}px
                        </label>
                        <input
                            type="range"
                            id="pointSize"
                            min="1"
                            max="15"
                            value={settings.pointSize}
                            onChange={(e) => handleChange('pointSize', Number(e.target.value))}
                        />
                    </div>

                    <div className="setting-item">
                        <label htmlFor="lineWidth">
                            線の太さ: {settings.lineWidth}px
                        </label>
                        <input
                            type="range"
                            id="lineWidth"
                            min="1"
                            max="10"
                            value={settings.lineWidth}
                            onChange={(e) => handleChange('lineWidth', Number(e.target.value))}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
