using Bakery.Gates.Filters;
using Bakery.Gates.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Bakery.Gates
{
    public static class Startup
    {
        public static void ConfigureServices(IServiceCollection services)
        {
            services.AddControllers(options =>
            {
                options.Filters.Add(typeof(KitchenAccessFilter));
                options.Filters.Add(typeof(OvenFaultFilter));
            });

            services.AddSingleton<IKitchenToggles, KitchenToggles>();
            services.AddScoped<IPastryService, PastryService>();
            services.AddScoped<IPastryRepository, PastryRepository>();
        }
    }
}
