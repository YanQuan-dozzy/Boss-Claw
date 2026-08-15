import { useEffect, useRef, useState } from 'react';
import { Button, Card, Space, Tag, Typography, message, Spin, Tooltip } from 'antd';
import { ApiOutlined, PlayCircleOutlined, PauseCircleOutlined, StopOutlined, FileTextOutlined, UploadOutlined, CloseCircleFilled } from '@ant-design/icons';
import { useAppStore } from '@/store/useAppStore';

const { Paragraph, Text } = Typography;
const BRIDGE_PORT = 18765;
const BRIDGE_TOKEN = 'bossclaw-desktop-bridge';
const base = `http://127.0.0.1:${BRIDGE_PORT}`;

export default function OpenClaw() {
  const [status, setStatus] = useState<any>(null);
  const [report, setReport] = useState('');
  const [logs, setLogs] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setBridgeStatus = useAppStore((s) => s.setBridgeStatus);

  const call = async (route: string, method = 'GET', body?: any) => {
    const url = `${base}${route}?token=${BRIDGE_TOKEN}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const s = await call('/status');
      setStatus(s);
      setBridgeStatus(s.ok ? 'connected' : 'disconnected');
    } catch {
      // OpenClaw 为可选项，未连接时静默降级，不弹错误提示
      setStatus(null);
      setBridgeStatus('disconnected');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const control = async (type: string) => {
    try {
      if (type === 'start') {
        // 桥接进程改为按需启动：经 IPC 让主进程 spawn（而非无条件自动启动）
        window.electron?.send?.('jc:bridge-control', 'start');
        message.success('正在启动 OpenClaw…');
        setTimeout(refresh, 800);
        return;
      }
      if (type === 'stop') {
        window.electron?.send?.('jc:bridge-control', 'stop');
        message.success('OpenClaw 已停止');
        refresh();
        return;
      }
      // pause 等指令走桥接 HTTP（需桥接进程已运行）
      await call('/command', 'POST', { type });
      message.success(`已发送指令：${type}`);
      refresh();
    } catch {
      message.warning('OpenClaw 未连接，请先点击「启动」');
      refresh();
    }
  };

  const loadReport = async () => {
    const r = await call('/report');
    setReport(r.report || JSON.stringify(r));
  };

  const loadLogs = async () => {
    const r = await call('/logs');
    setLogs(r);
  };

  const runOcr = async () => {
    if (!ocrFile) { message.warning('请先选择 PDF 简历'); return; }
    setLoading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(ocrFile);
      });
      const r = await call('/ocr', 'POST', { dataUrl });
      if (r.ok) { setOcrText(r.text); message.success(`OCR 成功（${r.method}）`); }
      else message.warning(r.error || 'OCR 未识别到可靠正文');
    } catch (e: any) {
      message.error(e?.message || 'OCR 失败');
    } finally { setLoading(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <ApiOutlined className="page-title-icon" />OpenClaw 本地桥接
          </h1>
          <p className="page-sub">
            可选的本地执行与恢复中心：OCR 解析扫描版 PDF、生成本地求职日报、保存/恢复任务状态、控制自动辅助。普通岗位分析不强制安装。
          </p>
        </div>
        <div className="page-head-extra">
          {status?.ok ? <Tag color="green">已连接</Tag> : <Tag color="red">未连接</Tag>}
        </div>
      </div>

      <Card size="small" className="mb-12">
        <Space wrap>
          <Button icon={<ApiOutlined />} onClick={refresh} loading={loading}>刷新状态</Button>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => control('start')}>启动</Button>
          <Button icon={<PauseCircleOutlined />} onClick={() => control('pause')}>暂停</Button>
          <Button icon={<StopOutlined />} onClick={() => control('stop')}>停止</Button>
          <Button onClick={loadReport}>查看日报</Button>
          <Button onClick={loadLogs}>查看日志</Button>
        </Space>
      </Card>

      {status && status.ok && (
        <Card size="small" title="桥接状态" style={{ marginBottom: 12 }}>
          <div className="bridge-meta">
            <div className="bm-cell"><div className="bm-label">版本</div><div className="bm-value">{status.version}</div></div>
            <div className="bm-cell"><div className="bm-label">运行中</div><div className="bm-value">{String(status.running)}</div></div>
            <div className="bm-cell"><div className="bm-label">已暂停</div><div className="bm-value">{String(status.paused)}</div></div>
            <div className="bm-cell"><div className="bm-label">解析器 pdftotext</div><div className="bm-value">{String(status.parsers?.pdftotext)}</div></div>
            <div className="bm-cell"><div className="bm-label">事件数</div><div className="bm-value">{status.events}</div></div>
            <div className="bm-cell"><div className="bm-label">数据库</div><div className="bm-value" style={{ fontSize: 12 }}>{status.databasePath}</div></div>
          </div>
        </Card>
      )}

      <Card size="small" title="扫描版 PDF / 特殊字体 OCR" style={{ marginBottom: 12 }}>
        <div className="ocr-row">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setOcrFile(f);
              e.target.value = ''; // 允许重复选择同一文件
            }}
          />
          {ocrFile ? (
            <Tooltip title="点击移除已选文件">
              <Button
                className="ocr-file-chip"
                icon={<FileTextOutlined />}
                onClick={() => {
                  setOcrFile(null);
                  setOcrText('');
                }}
              >
                <span className="ocr-file-name">{ocrFile.name}</span>
                <span className="ocr-file-size">{(ocrFile.size / 1024).toFixed(1)} KB</span>
                <CloseCircleFilled className="ocr-file-clear" />
              </Button>
            </Tooltip>
          ) : (
            <Button icon={<UploadOutlined />} onClick={() => fileInputRef.current?.click()}>
              选择 PDF 文件
            </Button>
          )}
          <Button
            type="primary"
            icon={<FileTextOutlined />}
            onClick={runOcr}
            loading={loading}
            disabled={!ocrFile}
          >
            解析
          </Button>
        </div>
        {ocrText && <Paragraph style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{ocrText.slice(0, 2000)}</Paragraph>}
      </Card>

      {report && (
        <Card size="small" title="求职日报" style={{ marginBottom: 12 }}>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{report}</pre>
        </Card>
      )}

      {logs && (
        <Card size="small" title="桥接日志" extra={<Button size="small" onClick={loadLogs}>刷新</Button>} style={{ marginBottom: 12 }}>
          <div style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, fontFamily: 'Consolas, monospace' }}>
            {(logs.events || []).length === 0 && (logs.commands || []).length === 0 ? (
              <Text type="secondary">暂无日志记录</Text>
            ) : (
              <>
                {(logs.events || []).slice(0, 30).map((e: any, i: number) => (
                  <div key={`e${i}`} style={{ padding: '2px 0' }}>
                    <Text type="secondary">[{new Date(e.ts).toLocaleTimeString()}]</Text> {e.message}
                  </div>
                ))}
                {(logs.commands || []).slice(0, 30).map((c: any, i: number) => (
                  <div key={`c${i}`} style={{ padding: '2px 0' }}>
                    <Text type="secondary">[{new Date(c.ts).toLocaleTimeString()}]</Text> 指令：{c.type}
                  </div>
                ))}
              </>
            )}
          </div>
        </Card>
      )}
      <Spin spinning={loading} />
    </div>
  );
}
