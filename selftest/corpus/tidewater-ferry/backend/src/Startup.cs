using Microsoft.Extensions.DependencyInjection;
using Tidewater.Ferry.Access;
using Tidewater.Ferry.Lookup;
using Tidewater.Ferry.Services;

namespace Tidewater.Ferry
{
    public static class Startup
    {
        public static void Configure(IServiceCollection services)
        {
            services.AddScoped<IPassengerAccess, PassengerAccess>();
            services.AddScoped<IRouteLookup, RouteLookup>();
            services.AddScoped<BoardingService>();
        }
    }
}
