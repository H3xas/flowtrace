using Ferry.Gateway.Gateway;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Ocelot.DependencyInjection;
using Ocelot.Middleware;

namespace Ferry.Gateway
{
    public class Startup
    {
        public void ConfigureServices(IServiceCollection services)
        {
            services.AddOcelot()
                .AddDelegatingHandler<TicketHandler>()
                .AddDelegatingHandler<AuditHandler>(true);
        }

        public void Configure(IApplicationBuilder app)
        {
            app.UseMiddleware<TraceMiddleware>();
            app.UseMiddleware<ClockMiddleware>();
            app.UseOcelot().Wait();
            app.UseMiddleware<LateMiddleware>();
        }
    }
}
