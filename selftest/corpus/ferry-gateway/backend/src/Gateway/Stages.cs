using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Ferry.Gateway.Gateway
{
    public interface IWakeRepository
    {
        Task SaveTicket(string ticket);
    }

    public class TicketHandler : DelegatingHandler
    {
        private readonly IWakeRepository _wakes;

        public TicketHandler(IWakeRepository wakes)
        {
            _wakes = wakes;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            await _wakes.SaveTicket(request.RequestUri.ToString());
            return await base.SendAsync(request, token);
        }
    }

    public class AuditHandler : DelegatingHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            return base.SendAsync(request, token);
        }
    }

    public class TraceMiddleware
    {
        private readonly RequestDelegate _next;

        public TraceMiddleware(RequestDelegate next)
        {
            _next = next;
        }

        public async Task InvokeAsync(HttpContext context)
        {
            await _next(context);
        }
    }

    public class ClockMiddleware
    {
        private readonly RequestDelegate _next;

        public ClockMiddleware(RequestDelegate next)
        {
            _next = next;
        }

        public Task Invoke(HttpContext context)
        {
            return _next(context);
        }
    }

    public class LateMiddleware
    {
        public Task Invoke(HttpContext context)
        {
            return Task.CompletedTask;
        }
    }
}
