import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'cooking.nextPlans.v1';
const CONFLICT_MESSAGE = '別のタブで記録が変更されています。今回の入力をJSONで書き出してから再読み込みしてください。';
const CHOICES = { change: '変更', maintain: '維持', defer: '保留' } as const;
const TEXT_FIELDS = {
    observation: '気付いた違い',
    reason: '選んだ理由',
    nextAction: '次の調理で行うこと・観察すること',
    checkMethod: '結果を確認する方法',
} as const;

interface EvidenceRecording {
    sessionId: string;
    videoName: string;
    startSec: number;
    endSec: number;
}

export interface PlanEvidence {
    self: EvidenceRecording;
    other: EvidenceRecording;
    presentationMode: 'video' | 'handWatch';
}

interface PlanDraft {
    observation: string;
    choice: '' | keyof typeof CHOICES;
    reason: string;
    nextAction: string;
    checkMethod: string;
    evidence: PlanEvidence | null;
}

interface SavedPlan extends PlanDraft {
    id: string;
    savedAt: string;
}

interface PlanStore {
    version: 1;
    draft: PlanDraft;
    plans: SavedPlan[];
}

function emptyDraft(): PlanDraft {
    return { observation: '', choice: '', reason: '', nextAction: '', checkMethod: '', evidence: null };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecording(value: unknown): value is EvidenceRecording {
    if (!isObject(value)) return false;
    return typeof value.sessionId === 'string' && value.sessionId.length > 0
        && typeof value.videoName === 'string' && value.videoName.length > 0
        && typeof value.startSec === 'number' && Number.isFinite(value.startSec) && value.startSec >= 0
        && typeof value.endSec === 'number' && Number.isFinite(value.endSec) && value.endSec > value.startSec;
}

function isEvidence(value: unknown): value is PlanEvidence {
    return isObject(value) && isRecording(value.self) && isRecording(value.other)
        && (value.presentationMode === 'video' || value.presentationMode === 'handWatch');
}

function isDraft(value: unknown): value is PlanDraft {
    return isObject(value)
        && Object.keys(TEXT_FIELDS).every(key => typeof value[key] === 'string' && value[key].length <= 2000)
        && typeof value.choice === 'string' && ['', 'change', 'maintain', 'defer'].includes(value.choice)
        && (value.evidence === null || isEvidence(value.evidence));
}

function isStore(value: unknown): value is PlanStore {
    return isObject(value) && value.version === 1 && isDraft(value.draft)
        && Array.isArray(value.plans) && value.plans.every(plan => isDraft(plan)
            && isObject(plan) && typeof plan.id === 'string' && plan.id.length > 0
            && typeof plan.savedAt === 'string' && Number.isFinite(Date.parse(plan.savedAt))
            && plan.choice !== '' && plan.evidence !== null
            && Object.keys(TEXT_FIELDS).every(key => (plan[key] as string).trim().length > 0));
}

function readStore(): { data: PlanStore; raw: string | null; error: string | null } {
    const empty: PlanStore = { version: 1, draft: emptyDraft(), plans: [] };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { data: empty, raw, error: null };
        const data: unknown = JSON.parse(raw);
        if (!isStore(data)) throw new Error('Invalid stored plans');
        return { data, raw, error: null };
    } catch {
        return {
            data: empty, raw: null,
            error: '保存領域を読み込めません。既存データは上書きしません。今回の入力はJSONで書き出してください。',
        };
    }
}

function downloadPlans(data: PlanStore) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cooking-plans-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EvidenceSummary({ evidence }: { evidence: PlanEvidence }) {
    return (
        <dl className="plan-evidence">
            <div>
                <dt>取り込み時の表示</dt>
                <dd>{evidence.presentationMode === 'video' ? '映像のみ' : 'Hand＋Watch'}</dd>
            </div>
            {(['self', 'other'] as const).map(side => (
                <div key={side}>
                    <dt>{side === 'self' ? '自分（記録A）' : '比較相手（記録B）'}</dt>
                    <dd>
                        <span>{evidence[side].startSec.toFixed(2)}–{evidence[side].endSec.toFixed(2)}秒</span>
                        <small>{evidence[side].videoName}</small>
                    </dd>
                </div>
            ))}
        </dl>
    );
}

export function NextPlanForm({ currentEvidence, onUnsavedChange }: {
    currentEvidence: PlanEvidence | null;
    onUnsavedChange: (dirty: boolean) => void;
}) {
    const [initial] = useState(readStore);
    const [data, setData] = useState(initial.data);
    const current = useRef(data);
    const lastRaw = useRef(initial.raw);
    const mounted = useRef(true);
    const writeGeneration = useRef(0);
    const [durable, setDurable] = useState(JSON.stringify(initial.data));
    const [exported, setExported] = useState('');
    const [storageError, setStorageError] = useState(initial.error);
    const [notice, setNotice] = useState('');
    const serialized = JSON.stringify(data);
    const dirty = serialized !== durable && serialized !== exported;

    useEffect(() => {
        mounted.current = true;
        const changedElsewhere = (event: StorageEvent) => {
            if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)
                && event.newValue !== lastRaw.current) {
                setDurable('');
                setStorageError(CONFLICT_MESSAGE);
            }
        };
        window.addEventListener('storage', changedElsewhere);
        return () => {
            mounted.current = false;
            window.removeEventListener('storage', changedElsewhere);
        };
    }, []);

    useEffect(() => {
        onUnsavedChange(dirty);
        const warn = (event: BeforeUnloadEvent) => {
            if (dirty) { event.preventDefault(); event.returnValue = ''; }
        };
        window.addEventListener('beforeunload', warn);
        return () => {
            window.removeEventListener('beforeunload', warn);
            onUnsavedChange(false);
        };
    }, [dirty, onUnsavedChange]);

    async function update(next: PlanStore) {
        current.current = next;
        setData(next);
        setNotice('');
        const generation = ++writeGeneration.current;
        const raw = JSON.stringify(next);
        try {
            if (initial.error) throw new Error(initial.error);
            if (!navigator.locks) throw new Error('この環境ではブラウザ内に保存できません。JSONで書き出してください。');
            await navigator.locks.request(STORAGE_KEY, () => {
                if (localStorage.getItem(STORAGE_KEY) !== lastRaw.current) {
                    if (mounted.current) setDurable('');
                    throw new Error(CONFLICT_MESSAGE);
                }
                localStorage.setItem(STORAGE_KEY, raw);
                lastRaw.current = raw;
            });
            if (mounted.current && generation === writeGeneration.current) {
                setDurable(raw);
                setStorageError(null);
            }
        } catch (error) {
            if (mounted.current && generation === writeGeneration.current) {
                setStorageError(error instanceof Error && !(error instanceof DOMException)
                    ? error.message
                    : 'ブラウザ内に保存できません。入力はこの画面に残っています。JSONで書き出してください。');
            }
        }
    }

    function changeDraft(patch: Partial<PlanDraft>) {
        void update({ ...current.current, draft: { ...current.current.draft, ...patch } });
    }

    function savePlan(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const draft = current.current.draft;
        if (!draft.evidence || !draft.choice || Object.keys(TEXT_FIELDS).some(key => !draft[key as keyof typeof TEXT_FIELDS].trim())) {
            setNotice('根拠区間と各入力項目を確認してください。違いがなければ、その旨を記入できます。');
            return;
        }
        void update({
            version: 1,
            draft: emptyDraft(),
            plans: [...current.current.plans, { ...draft, id: crypto.randomUUID(), savedAt: new Date().toISOString() }],
        });
    }

    return (
        <section className="next-plan" aria-labelledby="next-plan-title">
            <div className="plan-heading">
                <div>
                    <h3 id="next-plan-title">次の調理でどうするか</h3>
                    <p>記録Aを自分、記録Bを比較相手として記録します。維持・保留も選べます。</p>
                </div>
                <a href="#motion-comparison-title">映像に戻る ↑</a>
            </div>
            <form onSubmit={savePlan}>
                <fieldset className="plan-evidence-input">
                    <legend>判断の根拠</legend>
                    <button type="button" disabled={!currentEvidence} onClick={() => {
                        if (currentEvidence) changeDraft({ evidence: structuredClone(currentEvidence) });
                    }}>選択中の区間を取り込む</button>
                    {data.draft.evidence ? <>
                        <EvidenceSummary evidence={data.draft.evidence} />
                        <small>取り込んだ区間は固定されます。変更するときは再度取り込んでください。</small>
                    </> : <p>2本の動画を読み込み、比較する開始・終了時刻を指定してください。</p>}
                </fieldset>
                <div className="plan-field">
                    <label htmlFor="plan-observation">{TEXT_FIELDS.observation}</label>
                    <textarea id="plan-observation" required maxLength={2000} rows={2} value={data.draft.observation}
                        placeholder="例：自分は混ぜ続けていて、相手は途中で止めていた。違いがなければ「特になし」。"
                        onChange={event => changeDraft({ observation: event.target.value })} />
                </div>
                <fieldset className="plan-choices">
                    <legend>次回の方針</legend>
                    {Object.entries(CHOICES).map(([value, label]) => (
                        <label key={value}>
                            <input type="radio" name="plan-choice" value={value} required
                                checked={data.draft.choice === value}
                                onChange={() => changeDraft({ choice: value as keyof typeof CHOICES })} />
                            {label}
                        </label>
                    ))}
                </fieldset>
                <div className="plan-fields">
                    {(['reason', 'nextAction', 'checkMethod'] as const).map(key => (
                        <div className="plan-field" key={key}>
                            <label htmlFor={`plan-${key}`}>{TEXT_FIELDS[key]}</label>
                            <textarea id={`plan-${key}`} required maxLength={2000} rows={2} value={data.draft[key]}
                                onChange={event => changeDraft({ [key]: event.target.value })} />
                        </div>
                    ))}
                </div>
                <div className="plan-actions">
                    <button type="submit" className="plan-primary">方針を記録する</button>
                    <button type="button" onClick={() => {
                        try {
                            downloadPlans(current.current);
                            setExported(JSON.stringify(current.current));
                            setNotice('下書きと記録をJSONで書き出しました。');
                        } catch { setNotice('書き出せませんでした。入力を残したまま、もう一度試してください。'); }
                    }}>JSONを書き出す</button>
                    <span role="status">{storageError ? 'ブラウザ内に未保存の入力があります'
                        : serialized === durable ? '下書きと記録をブラウザ内に保存済み' : '保存中…'}</span>
                </div>
                {storageError && <p role="alert" className="comparison-error">{storageError}</p>}
                {notice && <p role="status">{notice}</p>}
                <p className="plan-storage-note">動画は保存されません。ブラウザのデータ削除に備え、終了前にJSONを書き出してください。</p>
            </form>
            {data.plans.length > 0 && (
                <details className="plan-history">
                    <summary>{`記録した方針（${data.plans.length}件）`}</summary>
                    {data.plans.map(plan => (
                        <article key={plan.id}>
                            <h4>{plan.choice && CHOICES[plan.choice]} · {plan.observation}</h4>
                            <time dateTime={plan.savedAt}>{new Date(plan.savedAt).toLocaleString('ja-JP')}</time>
                            {plan.evidence && <EvidenceSummary evidence={plan.evidence} />}
                            <dl>{(['reason', 'nextAction', 'checkMethod'] as const).map(key => (
                                <div key={key}><dt>{TEXT_FIELDS[key]}</dt><dd>{plan[key]}</dd></div>
                            ))}</dl>
                        </article>
                    ))}
                </details>
            )}
        </section>
    );
}
