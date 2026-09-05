using DemoShop.Api.DataAccess;
using DemoShop.Api.Messaging;
using DemoShop.Api.Services;
using Microsoft.Extensions.DependencyInjection;

namespace DemoShop.Api
{
    public static class Startup
    {
        public static void AddDemoShop(this IServiceCollection services)
        {
            services.AddScoped<ICatalogService, CatalogService>();
            services.AddScoped<IOrderService, OrderService>();
            services.AddScoped<IFulfilmentHandler, FulfilmentHandler>();
            services.AddScoped<IOrderReplayService, OrderReplayService>();
            services.AddScoped<IProductRepository, ProductRepository>();
            services.AddScoped<IOrderRepository, OrderRepository>();
            services.AddScoped<IPublishEndpoint, InMemoryPublishEndpoint>();
        }
    }
}
