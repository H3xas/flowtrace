using Microsoft.Extensions.DependencyInjection;
using Tidewater.Ferry.Mirror;

namespace Tidewater.Ferry.Mirror
{
    public static class MirrorStartup
    {
        public static void Configure(IServiceCollection services)
        {
            services.AddScoped<GateService>();
            services.AddScoped<IAnchorageLookup, AnchorageLookup>();
            services.AddScoped<IZephyrAccess, ZephyrAccess>();
        }
    }
}
