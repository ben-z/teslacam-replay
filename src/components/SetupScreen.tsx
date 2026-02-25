import { useEffect, useRef, useState } from "react";
import { fetchOAuthStartUrl, fetchStatus, submitFolderUrl } from "../api";
import "./SetupScreen.css";

interface Props {
  setupStep: "oauth" | "folder";
  onComplete: () => void;
}

export function SetupScreen({ setupStep, onComplete }: Props) {
  return (
    <div className="setup-container">
      <div className="setup-card">
        <div className="setup-header">
          <h1 className="setup-title">TeslaCam Replay</h1>
          <p className="setup-subtitle">Connect your Google Drive to get started.</p>
        </div>

        <div className="setup-steps">
          <div className={`setup-step ${setupStep === "oauth" ? "active" : "done"}`} />
          <div className={`setup-step ${setupStep === "folder" ? "active" : ""}`} />
        </div>

        {setupStep === "oauth" ? (
          <OAuthStep />
        ) : (
          <FolderStep onComplete={onComplete} />
        )}
      </div>
    </div>
  );
}

function DriveIcon() {
  return (
    <svg className="setup-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M8.01 18.28l2.09-3.62H22l-2.09 3.62H8.01z" fill="#3777E3" />
      <path d="M14.09 3H8.01L2 14.66l3.04-.01 5.05-8.65h4z" fill="#FFCF63" />
      <path d="M22 14.66L16.09 3h-6l6 11.66H22z" fill="#11A861" />
    </svg>
  );
}

function OAuthStep() {
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null);

  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = await fetchOAuthStartUrl();
      window.open(url, "_blank");
      setLoading(false);
      setWaiting(true);
      // Poll for status change after user completes OAuth in the other tab
      intervalRef.current = setInterval(async () => {
        try {
          const s = await fetchStatus();
          if (s.setupStep === "folder" || s.connected) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            window.location.reload();
          }
        } catch { /* ignore polling errors */ }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth");
      setLoading(false);
    }
  };

  return (
    <div>
      <p className="setup-desc">
        Sign in with Google to allow read-only access to your TeslaCam files on Drive.
      </p>
      <button className="setup-btn" onClick={handleConnect} disabled={loading || waiting}>
        {loading ? "Opening..." : waiting ? "Waiting for authorization..." : <><DriveIcon /> Connect Google Drive</>}
      </button>
      {error && <p className="setup-error">{error}</p>}
    </div>
  );
}

function FolderStep({ onComplete }: { onComplete: () => void }) {
  const [folderUrl, setFolderUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folderUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await submitFolderUrl(folderUrl.trim());
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set folder");
      setLoading(false);
    }
  };

  const disabled = loading || !folderUrl.trim();

  return (
    <form onSubmit={handleSubmit}>
      <p className="setup-desc">
        Paste the URL of your TeslaCam folder on Google Drive.
      </p>
      <input
        className="setup-input"
        type="text"
        value={folderUrl}
        onChange={(e) => setFolderUrl(e.target.value)}
        placeholder="https://drive.google.com/drive/folders/..."
        autoFocus
      />
      <button className="setup-btn" type="submit" disabled={disabled}>
        {loading ? "Connecting..." : "Continue"}
      </button>
      {error && <p className="setup-error">{error}</p>}
    </form>
  );
}
