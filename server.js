const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');
const path = require('path');

const app = express();

// 从环境变量获取配置
const PORT = process.env.PORT || 3006;
const PROXY_DOMAIN = process.env.PROXY_DOMAIN || `localhost:${PORT}`;

// 解析请求体 - 使用更灵活的解析方式
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 提供静态文件
app.use(express.static(path.join(__dirname, 'assets/dist')));

// 提取并验证目标URL
const getTargetUrl = (req) => {
  const parsedUrl = url.parse(req.url);
  const queryParams = querystring.parse(parsedUrl.query);
  
  if (!queryParams.url) {
    return null;
  }
  
  try {
    const targetUrl = new URL(queryParams.url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return null;
    }
    return targetUrl;
  } catch (e) {
    console.error('无效的目标URL:', e.message);
    return null;
  }
};

// 安全转换请求体为Buffer
const convertToBuffer = (body) => {
  if (!body) return null;
  
  // 已经是Buffer或string，直接处理
  if (body instanceof Buffer) return body;
  if (typeof body === 'string') return Buffer.from(body);
  
  // 对象类型转换为JSON字符串
  if (typeof body === 'object') {
    try {
      return Buffer.from(JSON.stringify(body));
    } catch (e) {
      console.error('转换对象为JSON失败:', e.message);
      return null;
    }
  }
  
  // 其他类型尝试转换为字符串
  return Buffer.from(String(body));
};

// 代理路由
app.all('/api/proxy', (req, res) => {
  // 防止重复发送响应的标志
  let responseSent = false;
  
  // 检查响应是否已发送
  const safeSend = (status, data) => {
    if (!responseSent && !res.headersSent) {
      responseSent = true;
      res.status(status).send(data);
    }
  };

  // 获取目标URL
  const targetUrl = getTargetUrl(req);
  if (!targetUrl) {
    return safeSend(400, '请提供有效的URL参数，格式: /api/proxy?url=https://example.com');
  }

  console.log(`代理请求: ${req.method} ${targetUrl.href}`);

  // 构造请求选项
  const path = targetUrl.pathname + targetUrl.search;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: path,
    method: req.method,
    headers: { ...req.headers }
  };

  // 修正Host头
  options.headers.host = targetUrl.host;
  
  // 移除可能导致问题的头信息
  delete options.headers['accept-encoding'];
  delete options.headers['origin'];

  // 选择协议模块
  const proxyModule = targetUrl.protocol === 'https:' ? https : http;

  // 发送代理请求
  const proxyReq = proxyModule.request(options, (proxyRes) => {
    console.log(`目标服务器响应: ${proxyRes.statusCode}`);

    // 准备修改响应头
    let modifiedHeaders = { ...proxyRes.headers };
    modifiedHeaders['x-proxy-server'] = 'ExpressFixedProxy';
    
    // 处理重定向
    if ([301, 302, 307, 308].includes(proxyRes.statusCode) && modifiedHeaders.location) {
      try {
        const redirectUrl = new URL(modifiedHeaders.location, targetUrl.href);
        const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http');
        const proxyRedirectUrl = new URL(`${protocol}://${PROXY_DOMAIN}/api/proxy`);
        proxyRedirectUrl.searchParams.set('url', redirectUrl.href);
        modifiedHeaders.location = proxyRedirectUrl.href;
      } catch (e) {
        console.error('处理重定向错误:', e.message);
      }
    }

    // 收集响应体
    const responseBody = [];
    
    proxyRes.on('data', (chunk) => {
      responseBody.push(chunk);
    });
    
    proxyRes.on('end', () => {
      if (responseSent) return; // 已发送响应则退出
      
      try {
        // 合并响应体
        let body = Buffer.concat(responseBody);
        
        // 处理文本内容
        let bodyStr;
        try {
          bodyStr = body.toString('utf8');
        } catch (e) {
          // 非文本内容直接转发
          res.writeHead(proxyRes.statusCode, modifiedHeaders);
          res.end(body);
          responseSent = true;
          return;
        }
        
        // 构建代理基础URL
        const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http');
        const proxyBaseUrl = `${protocol}://${PROXY_DOMAIN}/api/proxy?url=`;
        const targetOrigin = targetUrl.origin;
        const currentPageUrl = targetUrl.href;

        // 根据内容类型处理
        if (modifiedHeaders['content-type']) {
          // 处理HTML
          if (modifiedHeaders['content-type'].includes('text/html')) {
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["'](${targetOrigin})([^"']*)["']`, 'gi'),
              (match, attr, origin, path) => `${attr}="${proxyBaseUrl}${encodeURIComponent(origin + path)}"`
            );
            
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["']/([^"']*)["']`, 'gi'),
              (match, attr, path) => `${attr}="${proxyBaseUrl}${encodeURIComponent(targetOrigin + '/' + path)}"`
            );
            
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["']([^"']*[^/])["']`, 'gi'),
              (match, attr, path) => {
                if (path.startsWith(proxyBaseUrl) || path.includes('://')) return match;
                const fullUrl = new URL(path, currentPageUrl).href;
                return `${attr}="${proxyBaseUrl}${encodeURIComponent(fullUrl)}"`;
              }
            );
          }
          
          // 处理JavaScript
          else if (modifiedHeaders['content-type'].includes('javascript')) {
            bodyStr = bodyStr.replace(
              new RegExp(`(["'])([^"']+)\\1`, 'gi'),
              (match, quote, path) => {
                if (path.startsWith(proxyBaseUrl)) return match;
                try {
                  const fullUrl = new URL(path, currentPageUrl).href;
                  return `${quote}${proxyBaseUrl}${encodeURIComponent(fullUrl)}${quote}`;
                } catch (e) {
                  return match;
                }
              }
            );
            
            bodyStr = bodyStr.replace(
              new RegExp(`(fetch|open)\\(\\s*["']([^"']*)["']`, 'gi'),
              (match, method, path) => {
                try {
                  const fullUrl = new URL(path, currentPageUrl).href;
                  return `${method}("${proxyBaseUrl}${encodeURIComponent(fullUrl)}"`;
                } catch (e) {
                  return match;
                }
              }
            );
          }
          
          // 处理CSS
          else if (modifiedHeaders['content-type'].includes('text/css') ||
                   modifiedHeaders['content-type'].includes('stylesheet')) {
            bodyStr = bodyStr.replace(
              new RegExp(`url\\(\\s*["']?([^"')]+)["']?\\s*\\)`, 'gi'),
              (match, path) => {
                try {
                  const fullUrl = new URL(path, currentPageUrl).href;
                  return `url("${proxyBaseUrl}${encodeURIComponent(fullUrl)}")`;
                } catch (e) {
                  return match;
                }
              }
            );
          }
        }
        
        // 转换回Buffer并更新长度
        body = Buffer.from(bodyStr, 'utf8');
        modifiedHeaders['content-length'] = body.length;
        
        // 发送响应
        if (!responseSent) {
          res.writeHead(proxyRes.statusCode, modifiedHeaders);
          res.end(body);
          responseSent = true;
        }
      } catch (e) {
        console.error('处理响应体错误:', e.message);
        safeSend(500, `处理响应时出错: ${e.message}`);
      }
    });
  });

  // 处理代理请求错误
  proxyReq.on('error', (err) => {
    console.error('代理请求错误:', err);
    safeSend(500, `代理错误: ${err.message}`);
  });

  // 转发请求体 - 增加更灵活的处理
  if (!responseSent) {
    try {
      const requestBody = convertToBuffer(req.body);
      if (requestBody) {
        proxyReq.write(requestBody);
      }
      proxyReq.end();
    } catch (e) {
      console.error('转发请求体错误:', e.message);
      safeSend(400, `请求体处理错误: ${e.message}`);
    }
  }
});

// 根路由说明
app.get('/', (req, res) => {
  const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http');
  const baseUrl = `${protocol}://${PROXY_DOMAIN}`;
  res.send(`
    <h1>代理服务器已启动</h1>
    <p>使用方法: ${baseUrl}/api/proxy?url=目标URL</p>
    <p>示例: <a href="${baseUrl}/api/proxy?url=https://example.com">${baseUrl}/api/proxy?url=https://example.com</a></p>
  `);
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`代理服务器已启动，监听端口: ${PORT}`);
});
    