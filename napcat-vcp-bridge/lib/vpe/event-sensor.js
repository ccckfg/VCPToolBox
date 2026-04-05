const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const { formatLocalDateTime, parseLocalDateTime, toLocalDateString, uniqueStrings } = require('./utils');

class EventSensor {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.friendBook = options.friendBook;
        this.privateConfig = options.privateConfig || {};
        this.publicConfig = options.publicConfig || {};
        this.sensorConfig = options.sensorConfig || this.publicConfig.vpe || {};
        this.log = options.log || (() => {});
        this.userSchedulePath = path.join(this.projectRoot, '..', 'Plugin', 'UserSchedule', 'user_schedules.json');
        this.legacySchedulePath = path.join(this.projectRoot, '..', 'Plugin', 'ScheduleManager', 'schedules.json');
        this.sensorUrl = String(this.sensorConfig.sensorUrl || '').trim();
        this.sensorToken = String(this.sensorConfig.sensorToken || '').trim();
        this._legacyUnsafeWarned = false;
    }

    _readJson(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return [];
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (error) {
            this.log('WARN', `[VPE] 读取事件源失败 ${filePath}: ${error.message}`);
            return [];
        }
    }

    _resolveUserTarget(targetUser) {
        const input = String(targetUser || '').trim();
        if (!input) return null;

        const friendList = this.friendBook?.toList?.() || [];
        if (/^\d+$/.test(input)) {
            const exact = friendList.find((friend) => String(friend.user_id) === input);
            if (exact) {
                return {
                    userId: String(exact.user_id),
                    displayName: exact.remark || exact.nickname || String(exact.user_id),
                    matchedBy: 'qq'
                };
            }
        }

        const remarkMatch = friendList.find((friend) => friend.remark && friend.remark === input);
        if (remarkMatch) {
            return {
                userId: String(remarkMatch.user_id),
                displayName: remarkMatch.remark || remarkMatch.nickname || String(remarkMatch.user_id),
                matchedBy: 'remark'
            };
        }

        const nicknameMatch = friendList.find((friend) => friend.nickname && friend.nickname === input);
        if (nicknameMatch) {
            return {
                userId: String(nicknameMatch.user_id),
                displayName: nicknameMatch.remark || nicknameMatch.nickname || String(nicknameMatch.user_id),
                matchedBy: 'nickname'
            };
        }

        return null;
    }

    _requestJson(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const transport = parsedUrl.protocol === 'https:' ? https : http;
            const req = transport.request(
                {
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: 'GET',
                    headers
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`HTTP ${res.statusCode}`));
                            return;
                        }
                        try {
                            resolve(JSON.parse(data));
                        } catch (error) {
                            reject(error);
                        }
                    });
                }
            );

            req.on('error', reject);
            req.setTimeout(5000, () => {
                req.destroy(new Error('SensorAggregator 请求超时'));
            });
            req.end();
        });
    }

    _createScheduleEvent(base) {
        const targetDate = parseLocalDateTime(base.time);
        if (!targetDate) return null;

        return {
            category: 'schedule',
            scope: 'private',
            source: base.source,
            sourceId: String(base.id),
            targetUserId: String(base.targetUserId),
            targetDisplayName: base.targetDisplayName,
            targetTimeMs: targetDate.getTime(),
            occurrenceDate: toLocalDateString(targetDate),
            content: String(base.content || '').trim(),
            text: `[日程提醒] ${formatLocalDateTime(targetDate)} ${String(base.content || '').trim()}`,
            metadata: base.metadata || {}
        };
    }

    _normalizeExternalEvent(entry) {
        if (!entry || typeof entry !== 'object') return null;

        const text = String(entry.text || entry.content || '').trim();
        if (!text) return null;

        const normalized = {
            category: String(entry.category || 'news'),
            scope: String(entry.scope || 'public'),
            source: String(entry.source || 'sensor_aggregator'),
            sourceId: String(entry.id || `${entry.category || 'event'}_${Date.now()}`),
            occurrenceDate: entry.occurrenceDate || toLocalDateString(new Date(entry.publishedAtMs || Date.now())),
            content: String(entry.content || entry.text || '').trim(),
            text,
            intrinsicScore: Number(entry.intrinsicScore) || 0.5,
            expiresAfterHours: Number(entry.expiresAfterHours) || 6,
            publishedAtMs: Number(entry.publishedAtMs) || Date.now(),
            metadata: entry.metadata || {}
        };

        if (entry.targetUserId || entry.target_user) {
            const resolved = entry.targetUserId
                ? { userId: String(entry.targetUserId), displayName: String(entry.targetDisplayName || entry.targetUserId), matchedBy: 'explicit' }
                : this._resolveUserTarget(entry.target_user);
            if (!resolved) {
                this.log('WARN', `[VPE] 外部事件无法解析 target_user，已跳过: ${entry.target_user || entry.targetUserId || '空值'}`);
                return null;
            }
            normalized.targetUserId = resolved.userId;
            normalized.targetDisplayName = resolved.displayName;
            normalized.metadata = {
                ...normalized.metadata,
                matchedBy: resolved.matchedBy
            };
        }

        if (entry.targetGroupId || entry.target_group_id) {
            normalized.targetGroupId = String(entry.targetGroupId || entry.target_group_id);
        }

        if (entry.targetTimeMs || entry.time) {
            const targetTime = Number(entry.targetTimeMs) || parseLocalDateTime(entry.time)?.getTime();
            if (targetTime) {
                normalized.targetTimeMs = targetTime;
                normalized.occurrenceDate = toLocalDateString(new Date(targetTime));
            }
        }

        return normalized;
    }

    async _collectExternalEvents() {
        if (!this.sensorUrl) return [];

        const headers = {};
        if (this.sensorToken) {
            headers.Authorization = `Bearer ${this.sensorToken}`;
        }
        const url = this.sensorUrl.endsWith('/events')
            ? this.sensorUrl
            : `${this.sensorUrl.replace(/\/$/, '')}/events`;

        try {
            const payload = await this._requestJson(url, headers);
            const events = Array.isArray(payload?.events) ? payload.events : [];
            return events
                .map((event) => this._normalizeExternalEvent(event))
                .filter(Boolean);
        } catch (error) {
            this.log('WARN', `[VPE] SensorAggregator 拉取失败，已静默降级: ${error.message}`);
            return [];
        }
    }

    collectEvents() {
        const events = [];
        const userSchedules = this._readJson(this.userSchedulePath);
        for (const entry of userSchedules) {
            const resolved = this._resolveUserTarget(entry.target_user);
            if (!resolved) {
                this.log('WARN', `[VPE] UserSchedule 无法解析归属用户，已跳过: ${entry.target_user || '空值'} | ${entry.content || ''}`);
                continue;
            }

            const event = this._createScheduleEvent({
                source: 'user_schedule',
                id: entry.id || `${entry.target_user}_${entry.time}_${entry.content}`,
                targetUserId: resolved.userId,
                targetDisplayName: resolved.displayName,
                time: entry.time,
                content: entry.content,
                metadata: {
                    matchedBy: resolved.matchedBy,
                    rawTargetUser: entry.target_user
                }
            });
            if (event) events.push(event);
        }

        const legacySchedules = this._readJson(this.legacySchedulePath);
        const whitelist = uniqueStrings(this.privateConfig.whitelist || []).map(String);
        const explicitTarget = this.privateConfig?.vpe?.legacyScheduleTargetUserId
            ? String(this.privateConfig.vpe.legacyScheduleTargetUserId)
            : '';
        const safeLegacyTarget = explicitTarget || (whitelist.length === 1 ? whitelist[0] : '');

        if (!safeLegacyTarget && legacySchedules.length && !this._legacyUnsafeWarned) {
            this._legacyUnsafeWarned = true;
            this.log('WARN', '[VPE] 旧 ScheduleManager 日程缺少用户归属，当前未配置安全目标用户，已全部忽略。');
        }

        if (safeLegacyTarget) {
            const targetInfo = this.friendBook?.getInfo?.(safeLegacyTarget);
            const targetDisplayName = targetInfo?.remark || targetInfo?.nickname || safeLegacyTarget;
            for (const entry of legacySchedules) {
                const event = this._createScheduleEvent({
                    source: 'legacy_schedule',
                    id: entry.id || `${entry.time}_${entry.content}`,
                    targetUserId: safeLegacyTarget,
                    targetDisplayName,
                    time: entry.time,
                    content: entry.content,
                    metadata: {
                        compatibilityMode: true
                    }
                });
                if (event) events.push(event);
            }
        }

        return events;
    }

    async collectEventsAsync() {
        const localEvents = this.collectEvents();
        const externalEvents = await this._collectExternalEvents();
        return localEvents.concat(externalEvents);
    }
}

module.exports = {
    EventSensor
};
