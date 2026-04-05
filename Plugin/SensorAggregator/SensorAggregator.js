const fs = require('fs');
const path = require('path');

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

class SensorAggregator {
    constructor() {
        this.name = 'SensorAggregator';
        this.token = '';
        this.defaultCity = 'Shanghai';
        this.newsLimit = 3;
        this.projectBasePath = process.cwd();
    }

    initialize(config) {
        this.token = config.SENSOR_TOKEN || process.env.SENSOR_TOKEN || '';
        this.defaultCity = config.DEFAULT_CITY || process.env.DEFAULT_CITY || 'Shanghai';
        this.newsLimit = Math.max(1, Number(config.NEWS_LIMIT) || 3);
        this.projectBasePath = config.PROJECT_BASE_PATH || process.cwd();
        console.log('[SensorAggregator] 插件初始化完成。');
    }

    registerApiRoutes(router) {
        const authMiddleware = (req, res, next) => {
            if (!this.token) return next();
            const authHeader = req.headers['authorization'];
            const providedToken = authHeader?.startsWith('Bearer ')
                ? authHeader.slice(7)
                : req.query?.token;
            if (providedToken === this.token) return next();
            return res.status(401).json({ error: 'Unauthorized' });
        };

        router.get('/events', authMiddleware, async (req, res) => {
            try {
                const events = []
                    .concat(await this._collectWeatherEvents())
                    .concat(await this._collectNewsEvents());

                return res.json({
                    events,
                    fetchedAt: Date.now()
                });
            } catch (err) {
                console.error('[SensorAggregator] events 失败:', err);
                return res.status(500).json({ error: err.message });
            }
        });

        router.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                weatherCache: fs.existsSync(this._weatherCachePath()),
                dailyHotCache: fs.existsSync(this._dailyHotCachePath())
            });
        });

        console.log('[SensorAggregator] API 路由已注册: GET /events, GET /health');
    }

    _weatherCachePath() {
        return path.join(this.projectBasePath, 'Plugin', 'WeatherReporter', 'weather_cache.json');
    }

    _dailyHotCachePath() {
        return path.join(this.projectBasePath, 'Plugin', 'DailyHot', 'dailyhot_cache.md');
    }

    async _collectWeatherEvents() {
        const cachePath = this._weatherCachePath();
        if (!fs.existsSync(cachePath)) return [];

        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        } catch (err) {
            console.warn('[SensorAggregator] 天气缓存读取/解析失败，已跳过:', err.message);
            return [];
        }
        const hourly = Array.isArray(parsed?.hourly) ? parsed.hourly : [];
        if (!hourly.length) return [];

        const now = Date.now();
        const closest = hourly.find((item) => new Date(item.fxTime).getTime() >= now) || hourly[0];
        const warnings = Array.isArray(parsed?.warning) ? parsed.warning.filter((item) => item?.status === 'active') : [];
        const pop = Number(closest.pop) || 0;
        const temp = Number(closest.temp);
        const warningText = warnings.length
            ? `，当前预警：${warnings.slice(0, 2).map((item) => item.title || item.text || item.typeName).filter(Boolean).join('；')}`
            : '';

        const text = `天气提示：${closest.text || '未知天气'}，气温 ${Number.isFinite(temp) ? temp : closest.temp}°C，湿度 ${closest.humidity || '未知'}%，降水概率 ${pop}%${warningText}`;
        const stat = fs.statSync(cachePath);
        const intrinsicScore = warnings.length > 0
            ? 0.82
            : clamp(0.42 + (pop / 100) * 0.35, 0.42, 0.72);

        return [{
            id: `weather_${new Date(stat.mtimeMs).toISOString().slice(0, 13)}`,
            category: 'weather',
            scope: 'public',
            source: 'sensor_aggregator',
            text,
            content: text,
            intrinsicScore,
            expiresAfterHours: warnings.length > 0 ? 3 : 6,
            publishedAtMs: stat.mtimeMs,
            metadata: {
                city: this.defaultCity,
                weather: closest.text || '',
                pop,
                warningCount: warnings.length
            }
        }];
    }

    async _collectNewsEvents() {
        const cachePath = this._dailyHotCachePath();
        if (!fs.existsSync(cachePath)) return [];

        let raw;
        try {
            raw = fs.readFileSync(cachePath, 'utf-8');
        } catch (err) {
            console.warn('[SensorAggregator] 热点缓存读取失败，已跳过:', err.message);
            return [];
        }
        const lines = raw.split(/\r?\n/);
        const results = [];
        let currentSource = '热点';
        const stat = fs.statSync(cachePath);

        for (const line of lines) {
            const sourceMatch = line.match(/^##\s+(.+)$/);
            if (sourceMatch) {
                currentSource = sourceMatch[1].trim();
                continue;
            }

            const itemMatch = line.match(/^\d+\.\s+\[(.+?)\]\((.+?)\)$/);
            if (!itemMatch) continue;

            results.push({
                title: itemMatch[1].trim(),
                url: itemMatch[2].trim(),
                source: currentSource
            });
            if (results.length >= this.newsLimit) break;
        }

        return results.map((item, index) => {
            const intrinsicScore = clamp(0.62 - (index * 0.05), 0.48, 0.62);
            const text = `热点话题：${item.title}（来源：${item.source}）`;
            return {
                id: `news_${index + 1}_${Math.floor(stat.mtimeMs)}`,
                category: 'news',
                scope: 'public',
                source: 'sensor_aggregator',
                text,
                content: text,
                intrinsicScore,
                expiresAfterHours: 4,
                publishedAtMs: stat.mtimeMs,
                metadata: {
                    source: item.source,
                    url: item.url
                }
            };
        });
    }
}

module.exports = new SensorAggregator();
