using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Pipelines;

namespace Bakery.Api.Services
{
    public interface IOrderService
    {
        Task<Order> PlaceAsync(OrderRequest request);
        Task<Order> DraftAsync(OrderRequest request);
        Task<Order> PrecheckAsync(OrderRequest request);
        bool Check(OrderRequest request);
        Task<bool> CancelAsync(string id);
        Task<Order> LayerAsync(OrderRequest request);
    }

    public class OrderService : IOrderService
    {
        private readonly IPlacementPipeline _placement;
        private readonly IDraftPipeline _drafts;
        private readonly IPrecheckPipeline _prechecks;
        private readonly ICheckPipeline _checks;
        private readonly IGrantPipeline _grants;
        private readonly ILayerPipeline _layers;

        public OrderService(
            IPlacementPipeline placement,
            IDraftPipeline drafts,
            IPrecheckPipeline prechecks,
            ICheckPipeline checks,
            IGrantPipeline grants,
            ILayerPipeline layers)
        {
            _placement = placement;
            _drafts = drafts;
            _prechecks = prechecks;
            _checks = checks;
            _grants = grants;
            _layers = layers;
        }

        public async Task<Order> PlaceAsync(OrderRequest request)
        {
            var order = new Order(request);
            return await _placement.ProcessAsync(order);
        }

        public async Task<Order> DraftAsync(OrderRequest request)
        {
            var order = new Order(request);
            return await _drafts.ProcessAsync(order);
        }

        public async Task<Order> PrecheckAsync(OrderRequest request)
        {
            var order = new Order(request);
            return await _prechecks.ProcessAsync(order);
        }

        public bool Check(OrderRequest request)
        {
            var order = new Order(request);
            return _checks.Process(order);
        }

        public async Task<bool> CancelAsync(string id)
        {
            var context = new GrantContext(id);
            return await _grants.ProcessAsync(context);
        }

        public async Task<Order> LayerAsync(OrderRequest request)
        {
            var order = new Order(request);
            return await _layers.ProcessAsync(order);
        }
    }
}
