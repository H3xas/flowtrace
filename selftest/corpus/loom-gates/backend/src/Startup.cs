using Loom.Gates.Filters;
using Loom.Gates.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Loom.Gates
{
    public static class Startup
    {
        public static void ConfigureServices(IServiceCollection services)
        {
            services.AddControllers(options =>
            {
                options.Filters.Add(typeof(LoomGuardFilter));
            });

            services.AddScoped<IShuttleAudit, ShuttleAudit>();
            services.AddScoped<IThreadLedger, ThreadLedger>();
            services.AddScoped<IBobbinStore, BobbinStore>();
        }
    }
}
