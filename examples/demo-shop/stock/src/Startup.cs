using DemoShop.Stock.DataAccess;
using DemoShop.Stock.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DemoShop.Stock
{
    public static class Startup
    {
        public static void AddStock(this IServiceCollection services)
        {
            services.AddScoped<IReservationService, ReservationService>();
            services.AddScoped<IShelfRepository, ShelfRepository>();
        }
    }
}
