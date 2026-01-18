interface ScreenshotButtonProps {
    onClick: () => void;
    disabled?: boolean;
}

export function ScreenshotButton({ onClick, disabled }: ScreenshotButtonProps) {
    return (
        <button
            className="control-button screenshot-button"
            onClick={onClick}
            disabled={disabled}
            title="スクリーンショット"
        >
            <span className="button-icon">📷</span>
            <span className="button-text">スクリーンショット</span>
        </button>
    );
}
