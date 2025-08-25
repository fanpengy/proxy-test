const express = require('express');
const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');

const app = express();

// 从环境变量获取配置，适配Render部署
const PORT = process.env.PORT || 3006; // Render会自动分配端口
const PROXY_DOMAIN = process.env.PROXY_DOMAIN || `localhost:${PORT}`; // 可在Render设置中配置域名
app.use(express.static('assets/dist')); // 假设你的静态文件在dist目录下
// 解析请求体，用于转发POST等带数据的请求
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// 提取URL参数中的目标URL并验证
const getTargetUrl = (req) => {
  const parsedUrl = url.parse(req.url);
  const queryParams = querystring.parse(parsedUrl.query);
  
  // 检查是否提供了url参数
  if (!queryParams.url) {
    return null;
  }
  
  // 验证URL格式
  try {
    const targetUrl = new URL(queryParams.url);
    // 只允许http和https协议
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return null;
    }
    return targetUrl;
  } catch (e) {
    console.error('无效的目标URL:', e.message);
    return null;
  }
};

// 代理路由
app.all('/api/proxy', (req, res) => {
  // 获取并验证目标URL
  const targetUrl = getTargetUrl(req);
  if (!targetUrl) {
    return res.status(400).send('请提供有效的URL参数，格式: /api/proxy?url=https://example.com');
  }

  console.log(`代理请求: ${req.method} ${targetUrl.href}`);

  // 构造目标服务器的请求选项
  const path = targetUrl.pathname + targetUrl.search;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: path,
    method: req.method,
    headers: { ...req.headers }
  };

  // 修正Host头，指向目标服务器
  options.headers.host = targetUrl.host;
  
  // 移除可能导致问题的头信息
  delete options.headers['accept-encoding']; // 禁用压缩，便于修改内容
  delete options.headers['origin'];

  // 根据目标协议选择http或https模块
  const proxyModule = targetUrl.protocol === 'https:' ? https : http;

  // 向目标服务器发送请求
  const proxyReq = proxyModule.request(options, (proxyRes) => {
    console.log(`目标服务器响应: ${proxyRes.statusCode}`);

    // 准备修改响应头
    let modifiedHeaders = { ...proxyRes.headers };
    
    // 添加自定义代理头
    modifiedHeaders['x-proxy-server'] = 'ExpressRenderProxy';
    
    // 处理重定向，确保重定向后仍通过代理访问
    if ([301, 302, 307, 308].includes(proxyRes.statusCode) && modifiedHeaders.location) {
      try {
        // 解析重定向URL（处理相对路径重定向）
        const redirectUrl = new URL(modifiedHeaders.location, targetUrl.href);
        // 构建通过代理访问的重定向URL
        // 自动判断协议（Render部署通常使用https）
        const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http');
        const proxyRedirectUrl = new URL(`${protocol}://${PROXY_DOMAIN}/api/proxy`);
        proxyRedirectUrl.searchParams.set('url', redirectUrl.href);
        modifiedHeaders.location = proxyRedirectUrl.href;
      } catch (e) {
        console.error('处理重定向URL错误:', e.message);
      }
    }

    // 收集并修改响应体
    let responseBody = [];
    
    proxyRes.on('data', (chunk) => {
      responseBody.push(chunk);
    });
    
    proxyRes.on('end', () => {
      // 合并响应体
      let body = Buffer.concat(responseBody);
      
      // 尝试处理文本内容
      try {
        let bodyStr = body.toString('utf8');
        
        // 自动判断协议（Render部署通常使用https）
        const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http');
        // 构建代理服务器基础URL
        const proxyBaseUrl = `${protocol}://${PROXY_DOMAIN}/api/proxy?url=`;
        // 目标网站的根地址
        const targetOrigin = targetUrl.origin;
        // 当前页面的完整URL
        const currentPageUrl = targetUrl.href;

        // 针对不同内容类型进行URL替换
        if (modifiedHeaders['content-type']) {
          // 处理HTML内容
          if (modifiedHeaders['content-type'].includes('text/html')) {
            // 1. 处理绝对路径（带域名的URL）
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["'](${targetOrigin})([^"']*)["']`, 'gi'),
              (match, attr, origin, path) => {
                const fullUrl = `${origin}${path}`;
                return `${attr}="${proxyBaseUrl}${encodeURIComponent(fullUrl)}"`;
              }
            );
            
            // 2. 处理根相对路径（以/开头的路径）
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["']/([^"']*)["']`, 'gi'),
              (match, attr, path) => {
                const fullUrl = `${targetOrigin}/${path}`;
                return `${attr}="${proxyBaseUrl}${encodeURIComponent(fullUrl)}"`;
              }
            );
            
            // 3. 处理相对路径（不以/开头的路径）
            bodyStr = bodyStr.replace(
              new RegExp(`(src|href|action)=["']([^"']*[^/])["']`, 'gi'),
              (match, attr, path) => {
                // 排除已经是代理链接的情况或绝对URL
                if (path.startsWith(proxyBaseUrl) || path.includes('://')) {
                  return match;
                }
                
                // 构建完整URL
                const fullUrl = new URL(path, currentPageUrl).href;
                return `${attr}="${proxyBaseUrl}${encodeURIComponent(fullUrl)}"`;
              }
            );
          }
          
          // 处理JavaScript内容
          else if (modifiedHeaders['content-type'].includes('javascript')) {
            // 处理各种URL引用模式
            bodyStr = bodyStr.replace(
              new RegExp(`(["'])([^"']+)\\1`, 'gi'),
              (match, quote, path) => {
                // 排除已经是代理链接的情况
                if (path.startsWith(proxyBaseUrl)) {
                  return match;
                }
                
                try {
                  // 尝试解析URL
                  const fullUrl = new URL(path, currentPageUrl).href;
                  return `${quote}${proxyBaseUrl}${encodeURIComponent(fullUrl)}${quote}`;
                } catch (e) {
                  return match;
                }
              }
            );
            
            // 处理fetch和XMLHttpRequest
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
          
          // 处理CSS内容
          else if (modifiedHeaders['content-type'].includes('text/css') ||
                   modifiedHeaders['content-type'].includes('stylesheet')) {
            // 处理CSS中的url()引用
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
        
        // 转换回Buffer
        body = Buffer.from(bodyStr, 'utf8');
        
        // 更新内容长度
        modifiedHeaders['content-length'] = body.length;
      } catch (e) {
        console.log('非文本内容，直接转发');
      }
      
      // 发送修改后的响应给客户端
      res.writeHead(proxyRes.statusCode, modifiedHeaders);
      res.end(body);
    });
  });

  // 处理代理请求错误
  proxyReq.on('error', (err) => {
    console.error('代理请求错误:', err);
    res.status(500).send(`代理错误: ${err.message}`);
  });

  // 转发请求体（如POST数据）
  if (req.body) {
    proxyReq.write(req.body);
  }
  
  proxyReq.end();
});

// 根路由，提供使用说明
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
  console.log(`代理服务器已启动，监听端口 ${PORT}`);
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log(`Render部署后地址将自动配置为环境变量中的域名`);
});
    